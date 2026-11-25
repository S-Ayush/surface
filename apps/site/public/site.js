// The landing page's behaviour: the keyboard demo, the sync simulation, the install terminal and
// the shortcut keys. Every part is progressive: the page reads complete without this file, and
// nothing auto-plays when the visitor prefers reduced motion (PLAN-018 W-6).
(() => {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = isMac ? '⌘' : 'Ctrl';
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (text) =>
    String(text).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );

  for (const el of $$('.mod-label, #mod-key')) el.textContent = MOD;

  /** Calls `fn(true|false)` as `el` enters or leaves the viewport. */
  function watchVisible(el, fn, threshold = 0.25) {
    if (!el || !('IntersectionObserver' in window)) return fn(true);
    new IntersectionObserver(
      (entries) => {
        for (const entry of entries) fn(entry.isIntersecting);
      },
      { threshold },
    ).observe(el);
  }

  // ---------- Nav ----------
  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------- Icons ----------
  const STATUSES = [
    { name: 'Backlog', color: 'var(--faint)' },
    { name: 'Todo', color: 'var(--muted)' },
    { name: 'In Progress', color: 'var(--warn)' },
    { name: 'In Review', color: 'var(--ok)' },
    { name: 'Done', color: 'var(--accent)' },
    { name: 'Canceled', color: 'var(--faint)' },
  ];
  const statusOf = (name) => STATUSES.find((s) => s.name === name) || STATUSES[1];

  function statusIcon(name) {
    const { color } = statusOf(name);
    const ring = `<circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-width="1.5"`;
    const pie = (fraction) => {
      const angle = fraction * 2 * Math.PI;
      const x = 8 + 3.5 * Math.sin(angle);
      const y = 8 - 3.5 * Math.cos(angle);
      return `<path d="M8 8V4.5A3.5 3.5 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}Z" fill="${color}"/>`;
    };
    let inner = '';
    if (name === 'Backlog')
      return `<svg class="ico" viewBox="0 0 16 16">${ring} stroke-dasharray="2.2 2.2"/></svg>`;
    if (name === 'In Progress') inner = pie(0.5);
    if (name === 'In Review') inner = pie(0.75);
    if (name === 'Done')
      return `<svg class="ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.75" fill="${color}"/><path d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" stroke="var(--paper)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    if (name === 'Canceled')
      return `<svg class="ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.75" fill="${color}"/><path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" stroke="var(--paper)" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    return `<svg class="ico" viewBox="0 0 16 16">${ring}/>${inner}</svg>`;
  }

  const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];
  function priorityIcon(p) {
    if (p === 1)
      return '<svg class="ico" viewBox="0 0 16 16"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="var(--warn)"/><path d="M8 4.5v4.2M8 11h.01" stroke="var(--paper)" stroke-width="1.8" stroke-linecap="round"/></svg>';
    if (p === 0)
      return '<svg class="ico" viewBox="0 0 16 16"><path d="M3 8h1.5M7.25 8h1.5M11.5 8H13" stroke="var(--faint)" stroke-width="1.5" stroke-linecap="round"/></svg>';
    const filled = 4 - p; // High 2 → 3 bars … Low 4 → 1 bar
    const bars = [0, 1, 2]
      .map((i) => {
        const h = 4 + i * 3.5;
        return `<rect x="${2 + i * 4.5}" y="${13.5 - h}" width="3" height="${h}" rx="1" fill="${i < filled ? 'var(--muted)' : 'var(--hair)'}"/>`;
      })
      .join('');
    return `<svg class="ico" viewBox="0 0 16 16">${bars}</svg>`;
  }

  const PEOPLE = {
    AN: { name: 'Ana', color: '#a6e3d8' },
    BE: { name: 'Ben', color: '#c9b8f5' },
    CA: { name: 'Cam', color: '#f5c9a8' },
  };
  const ME = 'AN';
  const avatar = (who) =>
    who
      ? `<span class="av" style="background:${PEOPLE[who].color}" title="${PEOPLE[who].name}">${who}</span>`
      : '<svg class="ico" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="var(--faint)" stroke-width="1.25" stroke-dasharray="2 2"/></svg>';

  const LABELS = {
    Sync: 'var(--label-violet)',
    UX: 'var(--label-pink)',
    Editor: 'var(--label-blue)',
    Performance: 'var(--label-orange)',
    Auth: 'var(--accent)',
  };
  const chip = (label) =>
    `<span class="chip" style="color:${LABELS[label]}"><i></i><span style="color:var(--muted)">${label}</span></span>`;

  // ---------- The keyboard demo ----------
  const demo = $('#demo');
  if (demo) setUpDemo();

  function setUpDemo() {
    const list = $('#demo-list');
    const overlay = $('#demo-overlay');
    const keycap = $('#keycap');
    const timing = $('#timing-text');
    const mode = $('#demo-mode');

    const INITIAL = [
      {
        id: 142,
        title: 'Offline edits survive a browser restart',
        status: 'In Progress',
        priority: 2,
        label: 'Sync',
        who: 'AN',
      },
      {
        id: 139,
        title: 'Shortcut help lists every scope',
        status: 'In Progress',
        priority: 3,
        label: 'UX',
        who: 'BE',
      },
      {
        id: 153,
        title: 'Faster first load for large teams',
        status: 'Todo',
        priority: 1,
        label: 'Performance',
        who: null,
      },
      {
        id: 151,
        title: 'Paste images straight into comments',
        status: 'Todo',
        priority: 3,
        label: 'Editor',
        who: 'CA',
      },
      {
        id: 147,
        title: 'Show who changed a status in history',
        status: 'Todo',
        priority: 4,
        label: 'UX',
        who: null,
      },
      {
        id: 133,
        title: 'Invite links that expire after a week',
        status: 'Backlog',
        priority: 4,
        label: 'Auth',
        who: null,
      },
      {
        id: 128,
        title: 'Dark theme for code blocks',
        status: 'Backlog',
        priority: 0,
        label: 'Editor',
        who: null,
      },
    ];
    let issues = [];
    let nextId = 154;
    let focusId = 142;
    let menu = null; // { kind: 'status' | 'priority' | 'command', query, index }
    let flashId = null;

    const reset = () => {
      issues = INITIAL.map((i) => ({ ...i }));
      nextId = 154;
      focusId = 142;
      menu = null;
    };
    reset();

    // Lists show work in flight first, as Linear's do: started, unstarted, backlog, then closed.
    const GROUP_ORDER = ['In Progress', 'In Review', 'Todo', 'Backlog', 'Done', 'Canceled'].map(
      statusOf,
    );
    /** Issues in display order: grouped by status. */
    const ordered = () => GROUP_ORDER.flatMap((s) => issues.filter((i) => i.status === s.name));
    const focused = () => issues.find((i) => i.id === focusId);

    function renderList() {
      let out = '';
      for (const s of GROUP_ORDER) {
        const rows = issues.filter((i) => i.status === s.name);
        if (!rows.length) continue;
        out += `<div class="group">${statusIcon(s.name)}${s.name}<span class="n">${rows.length}</span></div>`;
        for (const i of rows) {
          const cls = [
            'row',
            i.id === focusId ? 'focus' : '',
            i.id === flashId ? 'flash' : '',
          ].join(' ');
          out += `<div class="${cls}" data-id="${i.id}">${priorityIcon(i.priority)}<span class="id">ENG-${i.id}</span>${statusIcon(i.status)}<span class="title">${esc(i.title)}</span>${chip(i.label)}${avatar(i.who)}</div>`;
        }
      }
      list.innerHTML = out;
      flashId = null;
      // Keep the focused row in view inside the list (never scroll the page).
      const row = $('.row.focus', list);
      if (row) {
        const top = row.offsetTop - list.offsetTop;
        if (top < list.scrollTop) list.scrollTop = top - 40;
        else if (top + row.offsetHeight > list.scrollTop + list.clientHeight)
          list.scrollTop = top + row.offsetHeight - list.clientHeight + 8;
      }
    }

    const COMMANDS = [
      { label: 'Create issue', key: 'C', run: () => openComposer() },
      { label: 'Change status…', key: 'S', run: () => openMenu('status') },
      { label: 'Change priority…', key: 'P', run: () => openMenu('priority') },
      { label: 'Assign to me', key: 'I', run: () => assignToMe() },
      { label: 'Move down', key: 'J', run: () => move(1) },
      { label: 'Move up', key: 'K', run: () => move(-1) },
    ];

    function menuItems() {
      if (!menu) return [];
      const q = menu.query.toLowerCase();
      const all =
        menu.kind === 'status'
          ? STATUSES.map((s, n) => ({
              label: s.name,
              icon: statusIcon(s.name),
              key: String(n + 1),
              value: s.name,
            }))
          : menu.kind === 'priority'
            ? PRIORITIES.map((p, n) => ({
                label: p,
                icon: priorityIcon(n),
                key: String(n),
                value: n,
              }))
            : COMMANDS.map((c) => ({ label: c.label, icon: '', key: c.key, value: c }));
      return all.filter((item) => item.label.toLowerCase().includes(q));
    }

    function renderMenu() {
      if (!menu) {
        overlay.hidden = true;
        overlay.innerHTML = '';
        return;
      }
      if (menu.kind === 'composer') return; // rendered once, owns its input
      const issue = focused();
      const items = menuItems();
      menu.index = Math.max(0, Math.min(menu.index, items.length - 1));
      const current =
        menu.kind === 'status' ? issue.status : menu.kind === 'priority' ? issue.priority : null;
      const placeholder =
        menu.kind === 'status'
          ? 'Change status…'
          : menu.kind === 'priority'
            ? 'Set priority…'
            : 'Type a command or search…';
      const rows = items
        .map((item, n) => {
          const on = n === menu.index ? ' class="on"' : '';
          const right =
            item.value === current
              ? '<span class="check">✓</span>'
              : `<span class="kbd">${item.key}</span>`;
          return `<li${on}>${item.icon}${esc(item.label)}${right}</li>`;
        })
        .join('');
      overlay.innerHTML = `<div class="menu"><div class="ctx"><span>ENG-${issue.id} ${esc(issue.title)}</span></div><div class="q" style="color:${menu.query ? 'var(--ink)' : 'var(--faint)'}">${esc(menu.query || placeholder)}</div><ul>${rows || '<li style="color:var(--faint)">No results</li>'}</ul><div class="foot"><span>↑↓ to move</span><span>↵ to select</span><span>esc to close</span></div></div>`;
      overlay.hidden = false;
    }

    /** Applies a change and shows how long the local re-render took. */
    function commit(change) {
      const t0 = performance.now();
      change();
      renderList();
      renderMenu();
      const ms = performance.now() - t0;
      timing.textContent = `rendered in ${ms < 1 ? ms.toFixed(2) : ms.toFixed(1)} ms`;
    }

    function showKey(label) {
      keycap.textContent = label;
      keycap.classList.remove('show');
      void keycap.offsetWidth; // restart the animation
      keycap.classList.add('show');
    }

    function move(delta) {
      const rows = ordered();
      const at = rows.findIndex((i) => i.id === focusId);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at + delta))];
      commit(() => {
        focusId = next.id;
      });
    }
    function openMenu(kind) {
      commit(() => {
        const issue = focused();
        menu = { kind, query: '', index: 0 };
        if (kind === 'status') menu.index = STATUSES.findIndex((s) => s.name === issue.status);
        if (kind === 'priority') menu.index = issue.priority;
      });
    }
    function closeMenu() {
      commit(() => {
        menu = null;
      });
      if (!auto) demo.focus({ preventScroll: true });
    }
    function setStatus(name) {
      commit(() => {
        focused().status = name;
        flashId = focusId;
        menu = null;
      });
    }
    function setPriority(p) {
      commit(() => {
        focused().priority = p;
        flashId = focusId;
        menu = null;
      });
    }
    function assignToMe() {
      commit(() => {
        focused().who = ME;
        flashId = focusId;
        menu = null;
      });
    }
    function choose(item) {
      if (!menu || !item) return;
      if (menu.kind === 'status') setStatus(item.value);
      else if (menu.kind === 'priority') setPriority(item.value);
      else {
        menu = null;
        item.value.run();
      }
    }

    function openComposer() {
      menu = { kind: 'composer' };
      overlay.innerHTML =
        '<div class="menu"><div class="ctx"><span>Engineering</span><span>New issue</span></div>' +
        '<div class="q"><input class="demo-input" id="composer-input" maxlength="80" placeholder="Issue title" aria-label="Issue title" autocomplete="off" /></div>' +
        `<div class="foot"><span>${statusIcon('Todo')}</span><span>Todo</span><span>↵ to create</span><span>esc to cancel</span></div></div>`;
      overlay.hidden = false;
      const input = $('#composer-input');
      // The autoplay types into it without taking focus from wherever the visitor is.
      if (!auto) input.focus({ preventScroll: true });
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') closeMenu();
        if (e.key === 'Enter') {
          e.preventDefault();
          createIssue(input.value);
        }
      });
    }
    function createIssue(title) {
      const clean = title.trim();
      if (!clean) return;
      commit(() => {
        const issue = {
          id: nextId++,
          title: clean,
          status: 'Todo',
          priority: 0,
          label: 'UX',
          who: null,
        };
        issues.push(issue);
        focusId = issue.id;
        flashId = issue.id;
        menu = null;
      });
      if (!auto) demo.focus({ preventScroll: true });
    }

    /** One key press, from the visitor or from the autoplay. Returns true when handled. */
    function press(key, { mod = false } = {}) {
      if (mod && key === 'k') {
        showKey(`${MOD} K`);
        if (menu && menu.kind === 'command') closeMenu();
        else openMenu('command');
        return true;
      }
      if (mod) return false;
      if (menu && menu.kind !== 'composer') {
        const items = menuItems();
        if (key === 'Escape') {
          showKey('Esc');
          closeMenu();
          return true;
        }
        if (key === 'Enter') {
          showKey('↵');
          choose(items[menu.index]);
          return true;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          showKey(key === 'ArrowDown' ? '↓' : '↑');
          commit(() => {
            menu.index =
              (menu.index + (key === 'ArrowDown' ? 1 : -1) + items.length) %
              Math.max(items.length, 1);
          });
          return true;
        }
        if (key === 'Backspace') {
          commit(() => {
            menu.query = menu.query.slice(0, -1);
          });
          return true;
        }
        if (menu.kind !== 'command' && /^[0-9]$/.test(key) && !menu.query) {
          const pick = menuItems().find((item) => item.key === key);
          if (pick) {
            showKey(key);
            choose(pick);
            return true;
          }
        }
        if (key.length === 1) {
          commit(() => {
            menu.query += key;
            menu.index = 0;
          });
          return true;
        }
        return false;
      }
      const actions = {
        j: () => move(1),
        ArrowDown: () => move(1),
        k: () => move(-1),
        ArrowUp: () => move(-1),
        s: () => openMenu('status'),
        p: () => openMenu('priority'),
        i: () => assignToMe(),
        c: () => openComposer(),
      };
      const action = actions[key];
      if (!action) return false;
      showKey({ ArrowDown: '↓', ArrowUp: '↑' }[key] || key.toUpperCase());
      action();
      return true;
    }

    // Visitor input stops the autoplay for good: the demo is theirs now.
    let auto = !reduced;
    let visible = false;
    const takeOver = () => {
      if (!auto) return;
      auto = false;
      mode.textContent = 'Your turn. It runs right here in the page.';
      reset();
      commit(() => {});
    };
    demo.addEventListener('pointerdown', takeOver);
    demo.addEventListener('focus', takeOver);
    demo.addEventListener('keydown', (e) => {
      if (e.target !== demo) return;
      if (e.altKey) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (mod && key !== 'k') return;
      if (press(key, { mod })) e.preventDefault();
    });
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      if (!row) return;
      commit(() => {
        focusId = Number(row.dataset.id);
      });
    });
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) {
        e.preventDefault();
        closeMenu();
      }
    });
    overlay.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (!li || !menu || menu.kind === 'composer') return;
      const index = $$('li', overlay).indexOf(li);
      choose(menuItems()[index]);
    });

    renderList();
    if (reduced) mode.textContent = 'Click it to try the keys.';

    const STOP = Symbol('stop');
    const step = async (ms) => {
      await wait(ms);
      while (auto && !visible) await wait(250);
      if (!auto) throw STOP;
    };
    const typeInto = async (text, each) => {
      for (const ch of text) {
        await step(70);
        each(ch);
      }
    };
    async function play() {
      for (;;) {
        reset();
        commit(() => {});
        await step(1200);
        press('j');
        await step(650);
        press('j');
        await step(700);
        press('s');
        await step(600);
        press('ArrowDown');
        await step(500);
        press('Enter');
        await step(1100);
        press('k');
        await step(650);
        press('p');
        await step(600);
        press('1');
        await step(1100);
        press('i');
        await step(1100);
        press('c');
        await step(500);
        const input = $('#composer-input');
        await typeInto('Ship the landing page', (ch) => {
          input.value += ch;
        });
        await step(400);
        showKey('↵');
        createIssue(input.value);
        await step(1100);
        press('k', { mod: true });
        await step(500);
        await typeInto('prio', (ch) => press(ch));
        await step(500);
        press('Enter');
        await step(600);
        press('2');
        await step(2600);
      }
    }
    watchVisible(demo, (v) => {
      visible = v;
    });
    if (auto)
      play().catch((e) => {
        if (e !== STOP) throw e;
      });
  }

  // ---------- Shortcut keys in the pillar ----------
  const keyEls = $$('#keys .k');
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    )
      return;
    const name =
      (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' ? 'mod+k' : e.key.toLowerCase();
    for (const el of keyEls) {
      if (el.dataset.key !== name) continue;
      el.classList.add('hit');
      setTimeout(() => el.classList.remove('hit'), 220);
    }
  });
  // Without a keyboard nearby, the keys light up in a short loop while in view.
  const keysBox = $('#keys');
  if (keysBox && !reduced) {
    let keysVisible = false;
    watchVisible(keysBox, (v) => {
      keysVisible = v;
    });
    const loop = ['mod+k', 'c', 's', 'j', 'k', 'p', 'i'];
    let n = 0;
    setInterval(() => {
      if (!keysVisible) return;
      const el = keyEls.find((k) => k.dataset.key === loop[n % loop.length]);
      n += 1;
      if (!el) return;
      el.classList.add('hit');
      setTimeout(() => el.classList.remove('hit'), 260);
    }, 900);
  }

  // ---------- Bars in the "instant" pillar ----------
  const bars = $('#bars');
  if (bars) watchVisible(bars, (v) => v && bars.classList.add('in-view'), 0.5);

  // ---------- Sync simulation ----------
  const sim = $('#sync-sim');
  if (sim) setUpSync();

  function setUpSync() {
    const CYCLE = ['Todo', 'In Progress', 'In Review', 'Done'];
    const seed = [
      { id: 142, title: 'Offline edits survive a browser restart', status: 'In Progress' },
      { id: 151, title: 'Paste images straight into comments', status: 'Todo' },
      { id: 153, title: 'Faster first load for large teams', status: 'Todo' },
      { id: 139, title: 'Shortcut help lists every scope', status: 'In Review' },
    ];
    const clients = {
      a: { el: $('#client-a'), rows: seed.map((r) => ({ ...r })) },
      b: { el: $('#client-b'), rows: seed.map((r) => ({ ...r })) },
    };
    const hub = $('.hub', sim);
    const serverLabel = $('.server span', sim);
    const toggle = $('#online-a');
    const queuedEl = $('#queued-a');
    const note = $('#b-note');
    let online = true;
    let queue = [];
    let syncId = 1041;

    function render(which, flashId) {
      const c = clients[which];
      $('.srows', c.el).innerHTML = c.rows
        .map((r) => {
          const icon = statusIcon(r.status);
          const button =
            which === 'a'
              ? `<button type="button" data-id="${r.id}" aria-label="Change status of ENG-${r.id}, now ${r.status}">${icon}</button>`
              : `<span role="img" aria-label="${r.status}">${icon}</span>`;
          return `<div class="srow${r.id === flashId ? ' changed' : ''}">${button}<span class="id">ENG-${r.id}</span><span class="title">${esc(r.title)}</span></div>`;
        })
        .join('');
    }
    render('a');
    render('b');

    function setOnline(value) {
      online = value;
      toggle.setAttribute('aria-checked', String(value));
      clients.a.el.classList.toggle('offline', !value);
      $('.state-text', clients.a.el).textContent = value ? 'Online' : 'Offline';
      if (value) flush();
      showQueue();
    }
    function showQueue() {
      queuedEl.textContent = queue.length
        ? `${queue.length} edit${queue.length > 1 ? 's' : ''} queued`
        : '';
    }

    const vertical = () => window.matchMedia('(max-width: 820px)').matches;
    /** Moves one dot from Ana's side, through the server, to Ben's side. */
    function travel() {
      const dot = document.createElement('span');
      dot.className = 'packet';
      hub.appendChild(dot);
      const v = vertical();
      const size = v ? hub.clientHeight : hub.clientWidth;
      const at = (f) =>
        v
          ? `translate(${hub.clientWidth / 2 - 5}px, ${f * size - hub.clientHeight / 2}px)`
          : `translate(${f * size - 5}px, 0)`;
      const duration = reduced ? 1 : 1100;
      const anim = dot.animate(
        [
          { transform: at(0), opacity: 0 },
          { transform: at(0.08), opacity: 1, offset: 0.08 },
          { transform: at(0.5), opacity: 1, offset: 0.45 },
          { transform: at(0.5), opacity: 1, offset: 0.55 },
          { transform: at(0.92), opacity: 1, offset: 0.92 },
          { transform: at(1), opacity: 0 },
        ],
        { duration, easing: 'cubic-bezier(.4,0,.2,1)' },
      );
      setTimeout(() => {
        syncId += 1;
        serverLabel.textContent = `sync #${syncId}`;
      }, duration * 0.5);
      return anim.finished.then(() => dot.remove());
    }

    async function send(change) {
      await travel();
      const row = clients.b.rows.find((r) => r.id === change.id);
      row.status = change.status;
      render('b', change.id);
      note.textContent = `ENG-${change.id} is now ${change.status}`;
    }
    async function flush() {
      const pending = queue;
      queue = [];
      showQueue();
      for (const change of pending) {
        send(change);
        await wait(reduced ? 0 : 260);
      }
    }

    function changeA(id) {
      const row = clients.a.rows.find((r) => r.id === id);
      row.status = CYCLE[(CYCLE.indexOf(row.status) + 1) % CYCLE.length];
      render('a', id);
      const change = { id, status: row.status };
      if (online) send(change);
      else {
        queue.push(change);
        showQueue();
      }
    }

    let auto = !reduced;
    const takeOver = () => {
      auto = false;
    };
    sim.addEventListener('pointerdown', takeOver);
    sim.addEventListener('keydown', takeOver);
    $('.srows', clients.a.el).addEventListener('click', (e) => {
      const button = e.target.closest('button[data-id]');
      if (!button) return;
      changeA(Number(button.dataset.id));
      $(`button[data-id="${button.dataset.id}"]`, clients.a.el).focus({ preventScroll: true });
    });
    toggle.addEventListener('click', () => setOnline(!online));

    let visible = false;
    watchVisible(sim, (v) => {
      visible = v;
    });
    const script = [
      () => changeA(151),
      () => changeA(142),
      () => setOnline(false),
      () => changeA(153),
      () => changeA(139),
      () => changeA(151),
      () => setOnline(true),
    ];
    let n = 0;
    if (auto)
      setInterval(() => {
        if (!auto || !visible) return;
        script[n % script.length]();
        n += 1;
      }, 1900);
  }

  // ---------- Install terminal ----------
  const term = $('#term code');
  if (term && !reduced) {
    const lines = term.innerHTML.replace(/<span class="caret"><\/span>$/, '').split('\n');
    let started = false;
    watchVisible(
      term,
      async (v) => {
        if (!v || started) return;
        started = true;
        term.innerHTML = '<span class="caret"></span>';
        let done = '';
        for (const line of lines) {
          const prompt = line.match(/^<span class="p">\$ <\/span>/);
          if (prompt) {
            const text = line.slice(prompt[0].length);
            for (let i = 1; i <= text.length; i += 1) {
              // Commands are plain escaped text, so slicing never splits a tag, only an entity.
              const part = text.slice(0, i);
              if (/&[a-z#0-9]*$/i.test(part)) continue;
              term.innerHTML = `${done}${prompt[0]}${part}<span class="caret"></span>`;
              await wait(22);
            }
            await wait(320);
          } else {
            await wait(line.includes('class="c"') ? 180 : 420);
          }
          done += `${line}\n`;
          term.innerHTML = `${done}<span class="caret"></span>`;
        }
        term.innerHTML = `${done.replace(/\n$/, '')}<span class="caret"></span>`;
      },
      0.4,
    );
  }
})();
