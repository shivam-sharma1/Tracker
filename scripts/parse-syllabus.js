#!/usr/bin/env node
/**
 * Parses the master syllabus markdown file ("list") plus the supplementary
 * JSON ("list-additional.json") into a single structured data file
 * (data/syllabus.js) consumed by the tracker web app.
 *
 * Structure produced:
 * {
 *   subjects: [
 *     {
 *       id, name, category,
 *       topics: [
 *         { id, code, name, subtopics: [ { id, name } ] }
 *       ]
 *     }
 *   ]
 * }
 *
 * Hierarchy (per the source file):
 *   "# N. NAME"    -> a SUBJECT   (24 of these)
 *   "## N.M Name"  -> a TOPIC     (~252 of these) — THIS is the trackable/
 *                     schedulable unit that the app studies/revises.
 *   "* bullet"     -> a SUBTOPIC  — reference detail shown inside a topic,
 *                     NOT independently scheduled or spaced-repeated.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIST_PATH = path.join(ROOT, 'list');
const ADDITIONAL_PATH = path.join(ROOT, 'list-additional.json');
const OUT_PATH = path.join(ROOT, 'data', 'syllabus.js');

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseList(raw) {
  const lines = raw.split(/\r?\n/);
  const subjects = [];
  let currentSubject = null;
  let currentTopic = null;
  let currentGroup = null; // H3 grouping within a topic (e.g. "President")

  const subjectRe = /^#\s+\d+\.\s+(.+)$/; // # 1. POLITY
  const topicRe = /^##\s+(\d+\.\d+)\s+(.+)$/; // ## 1.1 Name
  const groupRe = /^###\s+(.+)$/; // ### President
  const bulletRe = /^\*\s+(.+)$/;

  for (const line of lines) {
    let m;
    if ((m = line.match(subjectRe))) {
      const name = m[1].trim();
      if (/^TRACKER DESIGN RULES$/i.test(name)) {
        currentSubject = null;
        continue;
      }
      currentSubject = {
        id: slugify(name),
        name,
        category: '',
        topics: [],
      };
      subjects.push(currentSubject);
      currentTopic = null;
      currentGroup = null;
      continue;
    }
    if (!currentSubject) continue; // skip preamble/design rules section

    if ((m = line.match(topicRe))) {
      currentTopic = {
        id: `${currentSubject.id}__${slugify(m[2])}`,
        code: m[1],
        name: m[2].trim(),
        subtopics: [],
      };
      currentSubject.topics.push(currentTopic);
      currentGroup = null;
      continue;
    }
    if ((m = line.match(groupRe))) {
      currentGroup = m[1].trim();
      continue;
    }
    if ((m = line.match(bulletRe))) {
      if (!currentTopic) continue;
      const text = m[1].trim();
      const label = currentGroup ? `${currentGroup} — ${text}` : text;
      currentTopic.subtopics.push({
        id: `${currentTopic.id}__${slugify(label)}__${currentTopic.subtopics.length}`,
        name: label,
      });
    }
  }

  // Any topic with zero subtopics becomes its own single leaf item.
  for (const subj of subjects) {
    for (const topic of subj.topics) {
      if (topic.subtopics.length === 0) {
        topic.subtopics.push({ id: `${topic.id}__self`, name: topic.name });
      }
    }
  }

  // Drop trailing meta/reference sections that are not real trackable subjects
  // (e.g. "CROSS-SUBJECT INTEGRATION MAP", "RECOMMENDED STATUS MODEL" etc.).
  // These have no "## N.N" topic subheadings at all in the source list, unlike
  // every genuine syllabus subject, so they parse with zero topics.
  const realSubjects = subjects.filter((s) => s.topics.length > 0);
  return realSubjects;
}

function normalizeForMatch(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(str) {
  return new Set(normalizeForMatch(str).split(' ').filter((w) => w.length > 2));
}

function jaccard(a, b) {
  const inter = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function mergeAdditional(subjects, additionalRaw) {
  const additional = JSON.parse(additionalRaw);
  const bySubjectName = new Map(subjects.map((s) => [normalizeForMatch(s.name), s]));

  // Map additional subject_name -> best matching existing subject (by name overlap)
  for (const asub of additional.subjects) {
    let target = bySubjectName.get(normalizeForMatch(asub.subject_name));
    if (!target) {
      const aTokens = tokenSet(asub.subject_name);
      let best = null;
      let bestScore = 0;
      for (const s of subjects) {
        const score = jaccard(aTokens, tokenSet(s.name));
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
      }
      target = bestScore >= 0.2 ? best : null;
    }
    if (!target) {
      // Brand new subject not present at all in the master list.
      target = {
        id: slugify(asub.subject_name),
        name: asub.subject_name,
        category: asub.category || '',
        topics: [],
      };
      subjects.push(target);
    }
    if (asub.category && !target.category) target.category = asub.category;

    // The list-additional.json "topics" are coarse, compound descriptions
    // (e.g. one string bundles together what the master list splits into
    // 4-5 separate ## topics), so comparing against a single existing topic
    // name via Jaccard never matches even when the content is 100% already
    // covered. Instead, check what fraction of the additional topic's own
    // tokens are already present somewhere in the subject (across all of
    // its topic names AND subtopic bullets combined) — if most of it is
    // already represented, skip it as covered; only genuinely new material
    // becomes a new topic.
    const unionTokens = new Set();
    for (const t of target.topics) {
      for (const tok of tokenSet(t.name)) unionTokens.add(tok);
      for (const st of t.subtopics) for (const tok of tokenSet(st.name)) unionTokens.add(tok);
    }

    for (const topicStr of asub.topics || []) {
      const tTokens = [...tokenSet(topicStr)];
      const coveredCount = tTokens.filter((tok) => unionTokens.has(tok)).length;
      const coverageRatio = tTokens.length ? coveredCount / tTokens.length : 1;
      if (coverageRatio >= 0.6) continue; // already represented in the master list
      const newTopic = {
        id: `${target.id}__${slugify(topicStr)}`,
        code: 'X',
        name: topicStr,
        subtopics: [],
      };
      target.topics.push(newTopic);
      for (const tok of tTokens) unionTokens.add(tok);
    }
  }
  return subjects;
}

function main() {
  const raw = fs.readFileSync(LIST_PATH, 'utf8');
  let subjects = parseList(raw);
  const additionalRaw = fs.readFileSync(ADDITIONAL_PATH, 'utf8');
  subjects = mergeAdditional(subjects, additionalRaw);

  let totalTopics = 0;
  let totalSubtopics = 0;
  for (const s of subjects) {
    totalTopics += s.topics.length;
    for (const t of s.topics) totalSubtopics += t.subtopics.length;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const banner = `// AUTO-GENERATED by scripts/parse-syllabus.js — do not edit by hand.\n// Regenerate with: node scripts/parse-syllabus.js\n`;
  const body = `${banner}window.SYLLABUS = ${JSON.stringify({ subjects }, null, 2)};\n`;
  fs.writeFileSync(OUT_PATH, body, 'utf8');

  console.log(`Parsed ${subjects.length} subjects, ${totalTopics} topics (trackable units), ${totalSubtopics} reference subtopics.`);
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)}`);
}

main();
