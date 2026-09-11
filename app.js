// UPSC Revision Tracker — client-side app (no build step, no backend).
// All state lives in localStorage. Data model + scheduling algorithm below.

(function () {
  'use strict';

  const STORAGE_KEY = 'upsc-tracker-state-v1';
  const SUBJECTS = window.SYLLABUS.subjects;

  // ---------- Date helpers ----------
  function todayStr(d) {
    const dt = d || new Date();
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }
  function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  function daysBetween(fromStr, toStr) {
    const a = new Date(fromStr + 'T00:00:00');
    const b = new Date(toStr + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }

  // ---------- Flatten syllabus into leaf items, indexed ----------
  // The TRACKABLE/SCHEDULABLE unit is the TOPIC (a "## N.M Name" heading in
  // the source syllabus) — NOT the bullet points under it. Bullets are just
  // reference "subtopics" shown inside a topic card for context; they are
  // never independently scheduled or spaced-repeated.
  // leaf item: { id, subjectId, subjectName, subjectCategory, topicCode, name (topic name), subtopics: [string,...] }
  const LEAVES_BY_ID = new Map();
  const SUBJECT_INDEX = new Map(); // subjectId -> { subject, leaves: [] }

  for (const subj of SUBJECTS) {
    const leaves = [];
    for (const topic of subj.topics) {
      const leaf = {
        id: topic.id,
        subjectId: subj.id,
        subjectName: subj.name,
        subjectCategory: subj.category,
        topicCode: topic.code,
        name: topic.name,
        subtopics: topic.subtopics.map((st) => st.name),
      };
      LEAVES_BY_ID.set(leaf.id, leaf);
      leaves.push(leaf);
    }
    SUBJECT_INDEX.set(subj.id, { subject: subj, leaves });
  }

  const N_SUBJECTS = SUBJECTS.length;
  // Minimum mathematically achievable max-gap given exactly 2 *new* topics/day
  // from 2 different subjects: a full round-robin of N subjects needs at least
  // ceil(N/2) days. That is the true floor — we can't do better than this while
  // sticking to "2 new topics/day from 2 different subjects".
  const MAX_GAP_TARGET = Math.ceil(N_SUBJECTS / 2);

  // ---------- Difficulty -> revision interval (days) ----------
  // 5 -> 7 days, 1 -> 30 days, linear in between.
  function intervalForDifficulty(diff) {
    const days = 30 - (diff - 1) * ((30 - 7) / 4);
    return Math.round(days);
  }

  // ---------- State ----------
  function defaultState() {
    return {
      version: 2,
      createdAt: todayStr(),
      progress: {}, // leafId -> { status, difficulty, lastStudied, nextDue, revisionCount, sources: [], notes: '', history: [] }
      subjectLastTouched: {}, // subjectId -> dateStr (last time a NEW topic was introduced)
      subjectCursor: {}, // subjectId -> next index into leaves[] for "new topic"
      dailyPlan: {}, // dateStr -> { slots: [{id,kind:'new'}], extra: [{id,kind:'new'}] }
    };
  }

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return Object.assign(defaultState(), parsed);
    } catch (e) {
      console.error('Failed to load state, starting fresh', e);
      return defaultState();
    }
  }
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function getProgress(leafId) {
    return state.progress[leafId] || null;
  }
  function isStudied(leafId) {
    const p = getProgress(leafId);
    return !!(p && p.status === 'studied');
  }
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }

  // ---------- Scheduling algorithm ----------
  // DESIGN: "new topic" introduction and "revision" are deliberately decoupled.
  //
  // 1) New-topic rotation (the daily 2 slots): pure round-robin by staleness —
  //    always pick from the 2 subjects that have gone longest without a NEW
  //    topic, and take their next unstudied topic in syllabus order. This is
  //    independent of anything to do with reviews, which guarantees:
  //      - every subject is touched at least once every ceil(N_SUBJECTS/2) days
  //        (the mathematical floor for 2 subjects/day), deterministically.
  //      - the whole syllabus is provably covered in ceil(totalLeaves/2) days,
  //        since the cursor only ever moves forward.
  //    (An earlier version let overdue reviews compete for these same 2 slots
  //    with a big urgency bonus; once a subject's review interval was shorter
  //    than its natural round-robin gap, that subject got stuck re-reviewing
  //    its first topic forever and NEW topics for it were never reached. This
  //    design avoids that failure mode entirely.)
  //
  // 2) Revisions (spaced repetition): surfaced separately as "due today" and
  //    handled at the user's own pace — marking a revision done just updates
  //    its next-due date and never blocks or consumes a new-topic slot.

  function subjectsWithRemainingNewTopics() {
    return SUBJECTS.filter((subj) => {
      const { leaves } = SUBJECT_INDEX.get(subj.id);
      const cursor = state.subjectCursor[subj.id] || 0;
      for (let i = cursor; i < leaves.length; i++) {
        if (!getProgress(leaves[i].id)) return true;
      }
      return false;
    });
  }

  function nextNewLeafForSubject(subjectId) {
    const { leaves } = SUBJECT_INDEX.get(subjectId);
    const cursor = state.subjectCursor[subjectId] || 0;
    for (let i = cursor; i < leaves.length; i++) {
      if (!getProgress(leaves[i].id)) return leaves[i];
    }
    for (const leaf of leaves) {
      if (!getProgress(leaf.id)) return leaf;
    }
    return null;
  }

  function staleness(subjectId, dateStr) {
    const last = state.subjectLastTouched[subjectId];
    return last ? daysBetween(last, dateStr) : 999999;
  }

  function isValidPlan(plan) {
    if (!plan || !Array.isArray(plan.slots) || !Array.isArray(plan.extra)) return false;
    return [...plan.slots, ...plan.extra].every(
      (s) => s && typeof s === 'object' && typeof s.id === 'string' && LEAVES_BY_ID.has(s.id)
    );
  }

  function buildTodayPlan(dateStr) {
    if (state.dailyPlan[dateStr] && isValidPlan(state.dailyPlan[dateStr])) {
      return state.dailyPlan[dateStr];
    }

    const eligible = subjectsWithRemainingNewTopics()
      .map((subj) => ({ subj, score: staleness(subj.id, dateStr) }))
      .sort((a, b) => b.score - a.score);

    const slots = [];
    for (const { subj } of eligible) {
      if (slots.length >= 2) break;
      const leaf = nextNewLeafForSubject(subj.id);
      if (leaf) slots.push({ id: leaf.id, kind: 'new' });
    }
    const plan = { slots, extra: [] };
    state.dailyPlan[dateStr] = plan;
    save();
    return plan;
  }

  function pickExtraSlot(dateStr) {
    const plan = state.dailyPlan[dateStr];
    if (!plan) return null;
    const usedSubjects = new Set(
      [...plan.slots, ...plan.extra].map((s) => LEAVES_BY_ID.get(s.id).subjectId)
    );
    const eligible = subjectsWithRemainingNewTopics()
      .filter((subj) => !usedSubjects.has(subj.id))
      .map((subj) => ({ subj, score: staleness(subj.id, dateStr) }))
      .sort((a, b) => b.score - a.score);
    if (!eligible.length) return null;
    const leaf = nextNewLeafForSubject(eligible[0].subj.id);
    if (!leaf) return null;
    const chosen = { id: leaf.id, kind: 'new' };
    plan.extra.push(chosen);
    save();
    return chosen;
  }

  // Every studied topic whose next-due date has arrived, earliest first.
  function getDueRevisions(dateStr) {
    const due = [];
    for (const leaf of LEAVES_BY_ID.values()) {
      const p = getProgress(leaf.id);
      if (p && p.status === 'studied' && p.nextDue <= dateStr) due.push({ leaf, nextDue: p.nextDue });
    }
    due.sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1));
    return due.map((d) => d.leaf);
  }


  // ---------- Mark studied ----------
  // Used both for studying a brand-new topic and for completing a due revision;
  // only the "new topic" case advances subjectLastTouched/cursor, since those
  // exist purely to keep the new-topic round-robin fair and bounded. Revisions
  // deliberately do NOT touch that clock — otherwise a subject with lots of
  // due revisions would look "recently touched" and get starved of new topics.
  function markStudied(leafId, difficulty, dateStr) {
    const leaf = LEAVES_BY_ID.get(leafId);
    const existing = getProgress(leafId) || { sources: [], notes: '', history: [], revisionCount: 0 };
    const interval = intervalForDifficulty(difficulty);
    const nextDue = addDays(dateStr, interval);
    const wasNew = !state.progress[leafId];

    state.progress[leafId] = {
      status: 'studied',
      difficulty,
      lastStudied: dateStr,
      nextDue,
      revisionCount: (existing.revisionCount || 0) + 1,
      sources: existing.sources || [],
      notes: existing.notes || '',
      history: [...(existing.history || []), { date: dateStr, difficulty }],
    };

    if (wasNew) {
      state.subjectLastTouched[leaf.subjectId] = dateStr;
      const { leaves } = SUBJECT_INDEX.get(leaf.subjectId);
      const idx = leaves.findIndex((l) => l.id === leafId);
      const cursor = state.subjectCursor[leaf.subjectId] || 0;
      if (idx >= cursor) state.subjectCursor[leaf.subjectId] = idx + 1;
    }
    save();
  }

  // Undo a mark made earlier *today* (the "oops, wrong button" case). Only
  // reverts marks whose lastStudied === today, to keep this safe/simple:
  // - If this was the topic's very first study today, fully un-study it and
  //   roll back the new-topic cursor/lastTouched so it reappears in today's
  //   plan and the rotation isn't thrown off.
  // - If it was a revision completed today, restore the previous history
  //   entry's difficulty/nextDue instead of erasing all history.
  function unmarkStudied(leafId, dateStr) {
    const leaf = LEAVES_BY_ID.get(leafId);
    const p = getProgress(leafId);
    if (!p || p.lastStudied !== dateStr || !p.history.length) return;
    const todaysEntry = p.history[p.history.length - 1];
    if (todaysEntry.date !== dateStr) return;
    const wasFirstStudy = p.history.length === 1;
    p.history.pop();

    if (wasFirstStudy) {
      delete state.progress[leafId];
      const { leaves } = SUBJECT_INDEX.get(leaf.subjectId);
      const idx = leaves.findIndex((l) => l.id === leafId);
      const cursor = state.subjectCursor[leaf.subjectId] || 0;
      if (cursor === idx + 1) state.subjectCursor[leaf.subjectId] = idx;
      if (state.subjectLastTouched[leaf.subjectId] === dateStr) {
        delete state.subjectLastTouched[leaf.subjectId];
      }
    } else {
      const prev = p.history[p.history.length - 1];
      p.status = 'studied';
      p.difficulty = prev.difficulty;
      p.lastStudied = prev.date;
      p.nextDue = addDays(prev.date, intervalForDifficulty(prev.difficulty));
      p.revisionCount = Math.max(0, (p.revisionCount || 1) - 1);
    }
    save();
  }

  function addSource(leafId, sourceText) {
    if (!state.progress[leafId]) {
      state.progress[leafId] = { status: 'pending', sources: [], history: [], revisionCount: 0 };
    }
    state.progress[leafId].sources.push(sourceText);
    save();
  }
  function removeSource(leafId, idx) {
    const p = getProgress(leafId);
    if (!p) return;
    p.sources.splice(idx, 1);
    save();
  }

  // ---------- Rendering ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $all = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function fmtDate(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  function renderTopbar() {
    let studied = 0, total = 0;
    for (const leaf of LEAVES_BY_ID.values()) {
      total++;
      if (isStudied(leaf.id)) studied++;
    }
    const pct = total ? Math.round((studied / total) * 100) : 0;
    $('#topbarStats').textContent = `${studied}/${total} topics (${pct}%) · ${N_SUBJECTS} subjects`;
  }

  function leafCardHTML(leaf, kind, done) {
    const p = getProgress(leaf.id);
    const tagLabel = kind === 'review' ? `Revision · due ${p ? p.nextDue : ''}` : 'New topic';
    const noteText = (p && p.notes) ? p.notes.trim() : '';
    const notePreview = noteText
      ? `<div class="card-note">${escapeHtml(noteText.length > 80 ? `${noteText.slice(0, 77)}...` : noteText)}</div>`
      : '';
    const subtopicsPreview = leaf.subtopics && leaf.subtopics.length
      ? `<details class="subtopics-preview">
          <summary>${leaf.subtopics.length} subtopic${leaf.subtopics.length === 1 ? '' : 's'} covered</summary>
          <ul>${leaf.subtopics.map((s) => `<li>${s}</li>`).join('')}</ul>
        </details>`
      : '';
    return `
    <div class="card ${done ? 'done' : ''}" data-leaf="${leaf.id}">
      <span class="card-tag ${kind === 'review' ? 'review' : ''}">${tagLabel}</span>
      <div class="card-eyebrow">${leaf.subjectName}</div>
      <div class="card-title">${leaf.topicCode ? `${leaf.topicCode} ` : ''}${leaf.name}</div>
      ${notePreview}
      ${subtopicsPreview}
      ${done
        ? `<div class="done-badge">✔ Done today · difficulty ${p.difficulty} <button class="link-btn undo-btn" data-action="undo" data-leaf="${leaf.id}">Undo</button></div>`
        : `<div class="diff-row">
            ${[1, 2, 3, 4, 5].map((d) => `<button class="diff-btn" data-action="mark" data-leaf="${leaf.id}" data-diff="${d}">${d}<small>${intervalForDifficulty(d)}d</small></button>`).join('')}
          </div>`
      }
      <div class="card-footer">
        <span>${p && p.sources && p.sources.length ? p.sources.length + ' source(s)' : 'No sources yet'}</span>
        <button class="link-btn" data-action="sources" data-leaf="${leaf.id}">+ Add source</button>
      </div>
    </div>`;
  }

  function renderToday() {
    const dateStr = todayStr();
    $('#todayDate').textContent = fmtDate(dateStr);
    const plan = buildTodayPlan(dateStr);
    const allSlots = [...plan.slots, ...plan.extra];
    const html = allSlots.map(({ id, kind }) => {
      const leaf = LEAVES_BY_ID.get(id);
      const done = isStudied(id) && getProgress(id).lastStudied === dateStr;
      return leafCardHTML(leaf, kind, done);
    }).join('');
    $('#todayCards').innerHTML = html || '<p class="muted">Syllabus fully covered — no new topics left to introduce. Keep an eye on the Due &amp; Upcoming tab for revisions.</p>';

    const allDone = allSlots.length > 0 && allSlots.every(({ id }) => isStudied(id) && getProgress(id).lastStudied === dateStr);
    const extraWrap = $('#extraSlotWrap');
    extraWrap.innerHTML = allDone
      ? `<button class="btn secondary" id="extraBtn">+ Study one more new topic today</button>`
      : '';
    const extraBtn = $('#extraBtn');
    if (extraBtn) extraBtn.addEventListener('click', () => { pickExtraSlot(dateStr); renderToday(); });

    const dueLeaves = getDueRevisions(dateStr);
    const revisionsWrap = $('#revisionsWrap');
    if (dueLeaves.length) {
      revisionsWrap.innerHTML = `
        <h2 class="section-title">Revisions Due Today <span class="count-badge">${dueLeaves.length}</span></h2>
        <p class="muted">These don't take a "new topic" slot — clear as many or as few as you like today.</p>
        <div class="cards">${dueLeaves.map((leaf) => {
          const done = isStudied(leaf.id) && getProgress(leaf.id).lastStudied === dateStr;
          return leafCardHTML(leaf, 'review', done);
        }).join('')}</div>`;
    } else {
      revisionsWrap.innerHTML = '';
    }

    $('#rotationNote').innerHTML =
      `<strong>Rotation logic:</strong> With ${N_SUBJECTS} subjects and exactly 2 <em>new</em> topics/day, ` +
      `the mathematically minimum possible "max days untouched" per subject is <strong>${MAX_GAP_TARGET} days</strong> ` +
      `(ceil(${N_SUBJECTS}/2) — the floor for touching only 2 subjects per day). Each day the scheduler picks ` +
      `the 2 subjects that have gone longest without a new topic, and gives each its next unstudied topic in ` +
      `syllabus order. Revisions are tracked separately (above, and in the Due tab) so a backlog of overdue ` +
      `reviews can never block new-topic progress or slow down full syllabus coverage.`;
  }

  function renderDue() {
    const dateStr = todayStr();
    const items = [];
    for (const leaf of LEAVES_BY_ID.values()) {
      const p = getProgress(leaf.id);
      if (p && p.status === 'studied') {
        items.push({ leaf, nextDue: p.nextDue });
      }
    }
    items.sort((a, b) => (a.nextDue < b.nextDue ? -1 : 1));
    const html = items.slice(0, 200).map(({ leaf, nextDue }) => {
      const diff = daysBetween(dateStr, nextDue);
      let pillClass = 'future', label = `in ${diff}d`;
      if (diff < 0) { pillClass = 'overdue'; label = `overdue ${Math.abs(diff)}d`; }
      else if (diff <= 2) { pillClass = 'soon'; label = diff === 0 ? 'due today' : `in ${diff}d`; }
      return `<div class="row-item">
        <div>
          <div class="rname">${leaf.topicCode ? `${leaf.topicCode} ` : ''}${leaf.name}</div>
          <div class="rmeta">${leaf.subjectName}</div>
        </div>
        <span class="pill ${pillClass}">${label}</span>
      </div>`;
    }).join('');
    $('#dueList').innerHTML = html || '<p class="muted">No revisions scheduled yet — mark some topics as studied first.</p>';
  }

  function renderSubjects() {
    const dateStr = todayStr();
    $('#subjectsNote').textContent = `Minimum achievable max-gap for full rotation: ${MAX_GAP_TARGET} days.`;
    const html = SUBJECTS.map((subj) => {
      const { leaves } = SUBJECT_INDEX.get(subj.id);
      const studied = leaves.filter((l) => isStudied(l.id)).length;
      const pct = Math.round((studied / leaves.length) * 100);
      const last = state.subjectLastTouched[subj.id];
      const gap = last ? daysBetween(last, dateStr) : null;
      const gapLabel = gap === null ? 'never touched' : `${gap}d ago`;
      const gapWarn = gap !== null && gap > MAX_GAP_TARGET;
      return `<div class="subject-card">
        <h4>${subj.name}</h4>
        <div class="cat">${subj.category || ''}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="meta">
          <span>${studied}/${leaves.length} (${pct}%)</span>
          <span class="${gapWarn ? 'gap-warn' : ''}">${gapLabel}</span>
        </div>
      </div>`;
    }).join('');
    $('#subjectsList').innerHTML = html;
  }

  function renderBrowse(filter) {
    const q = (filter || '').trim().toLowerCase();
    const html = SUBJECTS.map((subj) => {
      const topicsHtml = subj.topics.filter((topic) => {
        if (!q) return true;
        return (
          subj.name.toLowerCase().includes(q) ||
          topic.name.toLowerCase().includes(q) ||
          topic.subtopics.some((st) => st.name.toLowerCase().includes(q))
        );
      }).map((topic) => {
        const p = getProgress(topic.id);
        let dotClass = '';
        if (p && p.status === 'studied') {
          dotClass = p.nextDue < todayStr() ? 'overdue' : 'studied';
        }
        const subtopicsHtml = topic.subtopics.length
          ? `<ul class="subtopic-ref-list">${topic.subtopics.map((st) => `<li>${st.name}</li>`).join('')}</ul>`
          : '';
        return `<div class="topic-group">
          <div class="leaf-row">
            <span class="status-dot ${dotClass}"></span>
            <h5>${topic.code || ''} ${topic.name}</h5>
            <button class="mini" data-action="sources" data-leaf="${topic.id}">sources</button>
          </div>
          ${subtopicsHtml}
        </div>`;
      }).join('');
      if (!topicsHtml) return '';
      return `<details ${q ? 'open' : ''}>
        <summary>${subj.name} <span class="muted">(${subj.category || ''})</span></summary>
        ${topicsHtml}
      </details>`;
    }).join('');
    $('#browseTree').innerHTML = html || '<p class="muted">No matches.</p>';
  }

  function renderStats() {
    let studied = 0, total = 0, dueOverdue = 0;
    const dateStr = todayStr();
    const diffCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const leaf of LEAVES_BY_ID.values()) {
      total++;
      const p = getProgress(leaf.id);
      if (p && p.status === 'studied') {
        studied++;
        if (p.nextDue < dateStr) dueOverdue++;
        if (diffCounts[p.difficulty] !== undefined) diffCounts[p.difficulty]++;
      }
    }
    const remaining = Math.max(0, total - studied);
    const onePassDays = Math.ceil(remaining / 2);
    const twoPassDays = Math.ceil((remaining * 2) / 2);
    const cards = [
      { num: studied, lbl: 'Topics studied' },
      { num: remaining, lbl: 'Topics remaining' },
      { num: `${Math.round((studied / total) * 100)}%`, lbl: 'Overall coverage' },
      { num: `${onePassDays}d`, lbl: '1 pass remaining' },
      { num: `${twoPassDays}d`, lbl: '2 passes remaining' },
      { num: dueOverdue, lbl: 'Overdue revisions' },
      { num: N_SUBJECTS, lbl: 'Subjects tracked' },
      { num: MAX_GAP_TARGET, lbl: 'Min. max-gap (days)' },
    ];
    $('#statsGrid').innerHTML = cards.map((c) => `<div class="stat-card"><div class="num">${c.num}</div><div class="lbl">${c.lbl}</div></div>`).join('');
  }

  function renderIntervalLegend() {
    const items = [1, 2, 3, 4, 5].map((d) => `<li>Difficulty ${d} → resurfaces in ${intervalForDifficulty(d)} days</li>`);
    $('#intervalLegend').innerHTML = items.join('');
  }

  function renderAll() {
    try {
      renderTopbar();
    } catch (e) { console.error('renderTopbar failed', e); }
    try {
      renderToday();
    } catch (e) { console.error('renderToday failed', e); }
    try {
      renderDue();
    } catch (e) { console.error('renderDue failed', e); }
    try {
      renderSubjects();
    } catch (e) { console.error('renderSubjects failed', e); }
    try {
      renderBrowse($('#browseSearch').value);
    } catch (e) { console.error('renderBrowse failed', e); }
    try {
      renderStats();
    } catch (e) { console.error('renderStats failed', e); }
    try {
      renderIntervalLegend();
    } catch (e) { console.error('renderIntervalLegend failed', e); }
  }

  // ---------- Modal (sources) ----------
  function saveTopicNote(leafId, noteText) {
    const p = getProgress(leafId) || { status: 'pending', sources: [], history: [], revisionCount: 0 };
    p.notes = noteText.trim();
    state.progress[leafId] = p;
    save();
  }

  function openSourceModal(leafId) {
    const leaf = LEAVES_BY_ID.get(leafId);
    const p = getProgress(leafId);
    const sources = (p && p.sources) || [];
    const notes = (p && p.notes) || '';
    $('#modalTitle').textContent = leaf.name;
    $('#modalBody').innerHTML = `
      <p class="muted">${leaf.subjectName}${leaf.topicCode ? ` · ${leaf.topicCode}` : ''}</p>
      <div id="srcList">
        ${sources.map((s, i) => `<div class="src-item"><span>${linkify(s)}</span><button class="icon-btn" data-action="rmsrc" data-leaf="${leaf.id}" data-idx="${i}">✕</button></div>`).join('') || '<p class="muted">No sources added yet.</p>'}
      </div>
      <div class="src-add-row">
        <input type="text" id="srcInput" placeholder="Book / video / link / notes…" />
        <button class="btn" id="srcAddBtn">Add</button>
      </div>
      <div class="notes-box">
        <label class="notes-label">Topic notes</label>
        <textarea id="topicNotesInput" rows="3" placeholder="Short memory cue / quick summary / tricky point…">${escapeHtml(notes)}</textarea>
        <button class="btn secondary" id="topicNotesSaveBtn">Save note</button>
      </div>
    `;
    $('#modalOverlay').classList.remove('hidden');
    $('#srcAddBtn').addEventListener('click', () => {
      const val = $('#srcInput').value.trim();
      if (!val) return;
      addSource(leafId, val);
      openSourceModal(leafId);
      renderAll();
    });
    $('#srcInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#srcAddBtn').click();
    });
    $('#topicNotesSaveBtn').addEventListener('click', () => {
      const val = $('#topicNotesInput').value.trim();
      saveTopicNote(leafId, val);
      openSourceModal(leafId);
      renderAll();
    });
  }
  function linkify(text) {
    if (/^https?:\/\//i.test(text)) return `<a href="${text}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    return text;
  }

  // ---------- Event delegation ----------
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) {
      // tab switching
      const tabBtn = e.target.closest('.tab-btn');
      if (tabBtn) switchTab(tabBtn.dataset.tab);
      return;
    }
    const action = t.dataset.action;
    if (action === 'mark') {
      markStudied(t.dataset.leaf, Number(t.dataset.diff), todayStr());
      renderAll();
    } else if (action === 'undo') {
      unmarkStudied(t.dataset.leaf, todayStr());
      renderAll();
    } else if (action === 'sources') {
      openSourceModal(t.dataset.leaf);
    } else if (action === 'rmsrc') {
      removeSource(t.dataset.leaf, Number(t.dataset.idx));
      openSourceModal(t.dataset.leaf);
      renderAll();
    }
  });

  function switchTab(name) {
    $all('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $all('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  }

  $('#modalClose').addEventListener('click', () => $('#modalOverlay').classList.add('hidden'));
  $('#modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('#modalOverlay')) $('#modalOverlay').classList.add('hidden');
  });

  $('#browseSearch').addEventListener('input', (e) => renderBrowse(e.target.value));

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `upsc-tracker-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        state = Object.assign(defaultState(), parsed);
        save();
        renderAll();
        alert('Backup imported successfully.');
      } catch (err) {
        alert('Invalid backup file.');
      }
    };
    reader.readAsText(file);
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('This will permanently erase all progress. Continue?')) return;
    state = defaultState();
    save();
    renderAll();
  });

  renderAll();
})();
