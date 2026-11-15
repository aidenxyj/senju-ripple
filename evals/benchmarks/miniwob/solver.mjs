// The --model stub's solver: one self-contained function that solves any of our MiniWoB++ tasks from inside
// the page, the way a careful person would: it reads the instruction in #query, finds the right elements,
// fills them in and clicks. It runs through browser_evaluate, so its source is sent to the browser as text
// and must not use anything outside its own body. It returns a short note of what it did.

/* eslint-disable no-undef */
export async function solveMiniwob(task) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !(document.getElementById('query')?.textContent ?? '').trim(); i++) await sleep(50);
  const q = document.getElementById('query').textContent.replace(/\s+/g, ' ').trim();
  const quoted = [...q.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const fill = (el, value) => { el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  const click = (el) => { if (!el) throw new Error(`nothing to click for: ${q}`); el.click(); };

  switch (task) {
    case 'click-button':
      click($$('#area button').find((b) => text(b) === quoted[0]));
      break;
    case 'enter-text':
      fill(document.getElementById('tt'), quoted[0]);
      click(document.getElementById('subbtn'));
      break;
    case 'login-user':
      fill(document.getElementById('username'), quoted[0]);
      fill(document.getElementById('password'), quoted[1]);
      click(document.getElementById('subbtn'));
      break;
    case 'click-checkboxes': {
      const want = q.replace(/^Select /, '').replace(/ and click Submit\.$/, '');
      const names = want === 'nothing' ? [] : want.split(', ');
      for (const label of $$('#boxes label')) {
        const box = label.querySelector('input');
        if (box.checked !== names.includes(text(label))) box.click();
      }
      click(document.getElementById('subbtn'));
      break;
    }
    case 'choose-list': {
      const item = q.replace(/^Select /, '').replace(/ from the list and click Submit\.$/, '');
      const sel = document.getElementById('options');
      sel.selectedIndex = [...sel.options].findIndex((o) => o.text === item);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      click($$('#area button').find((b) => text(b) === 'Submit'));
      break;
    }
    case 'use-autocomplete': {
      const [start, end] = quoted;
      const pick = ui_utils.COUNTRIES.find((c) => c.startsWith(start) && (end === undefined || c.endsWith(end)));
      fill(document.getElementById('tags'), pick);
      click(document.getElementById('subbtn'));
      break;
    }
    case 'enter-date': {
      const [mm, dd, yyyy] = q.match(/(\d{2})\/(\d{2})\/(\d{4})/).slice(1);
      fill(document.getElementById('tt'), `${yyyy}-${mm}-${dd}`);
      click(document.getElementById('subbtn'));
      break;
    }
    case 'search-engine': {
      const term = quoted[0];
      const n = Number(q.match(/the (\d+)(?:st|nd|rd|th) search result/)?.[1] ?? q.match(/(\d+)(?:st|nd|rd|th)/)[1]);
      fill(document.getElementById('search-text'), term);
      click(document.getElementById('search'));
      await sleep(200);
      const page = Math.ceil(n / 3);
      if (page > 1) {
        click($$('#pagination a').find((a) => text(a) === String(page)));
        await sleep(200);
      }
      click($$('#page-content a').find((a) => a.getAttribute('data-result') === String(n - 1)));
      break;
    }
    case 'social-media': {
      const user = q.match(/For the user (\S+),/)[1];
      const label = quoted[0];
      const cls = Object.keys(ACTIONS).find((k) => ACTIONS[k] === label);
      const post = $$('#area .media').find((m) => text(m.querySelector('.username')) === user);
      click(post.querySelector(`.${cls}`));
      break;
    }
    case 'email-inbox': {
      const name = q.match(/Find the email by (.+?) and /)[1];
      const thread = $$('#main .email-thread').find((t) => text(t.querySelector('.email-sender')) === name);
      if (/click the trash icon/.test(q)) { click(thread.querySelector('.email-actions .trash')); break; }
      if (/click the star icon/.test(q)) { click(thread.querySelector('.email-actions .star')); break; }
      click(thread);
      await sleep(100);
      if (/reply to them with the text/.test(q)) {
        click(document.querySelector('#email .email-reply'));
        await sleep(100);
        fill(document.getElementById('reply-text'), quoted[0]);
        click(document.getElementById('send-reply'));
      } else {
        const to = q.match(/forward that email to (.+?)\.$/)[1];
        click(document.querySelector('#email .email-forward'));
        await sleep(100);
        fill(document.querySelector('#forward .forward-sender'), to);
        click(document.getElementById('send-forward'));
      }
      break;
    }
    case 'book-flight': {
      const m = q.match(/Book the (cheapest|shortest) one-way flight from: (.+?) to: (.+?) on (\d{2}\/\d{2}\/\d{4})/);
      const [, which, from, to, date] = m;
      fill(document.getElementById('flight-from'), DOMESTIC_FLIGHTS.find((f) => f.includes(from)));
      fill(document.getElementById('flight-to'), DOMESTIC_FLIGHTS.find((f) => f.includes(to)));
      document.getElementById('datepicker').value = date;
      click(document.getElementById('search'));
      await sleep(200);
      const flights = $$('#results .flight');
      const key = (f) => (which === 'cheapest' ? Number(f.querySelector('.flight-price').dataset.price) : Number(f.querySelector('.time-duration').dataset.duration));
      const best = flights.reduce((a, b) => (key(b) < key(a) ? b : a));
      click(best.querySelector('.flight-price'));
      break;
    }
    default:
      throw new Error(`no solver for ${task}`);
  }
  await sleep(300);
  return `solved ${task}: ${q}`;
}
