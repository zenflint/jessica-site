import { Flight } from './flight.js';

const header = document.getElementById('site-header');
const flightSection = document.getElementById('tour');

/* ---------- Fly-through ---------- */

let flight = null;
if (flightSection) {
  flight = new Flight(flightSection);
  flight.start();
}

/* ---------- Header: glass over the fly-through, solid once it has scrolled past ---------- */

function updateHeader() {
  if (!header) return;
  const menuOpen = document.documentElement.classList.contains('menu-open');
  let solid = true;
  if (flightSection) {
    const bottom = flightSection.getBoundingClientRect().bottom;
    solid = bottom <= header.getBoundingClientRect().bottom;
  }
  const state = solid || menuOpen ? 'solid' : 'glass';
  if (header.dataset.state !== state) header.dataset.state = state;
}
window.addEventListener('scroll', updateHeader, { passive: true });
window.addEventListener('resize', updateHeader);
window.addEventListener('orientationchange', updateHeader);
window.addEventListener('load', updateHeader);
updateHeader();

/* ---------- Mobile menu ---------- */

const toggle = header?.querySelector('.menu-toggle');
const menu = document.getElementById('mobile-menu');
const menuLabel = toggle?.querySelector('[data-menu-label]');
const outside = () => [document.querySelector('main'), document.querySelector('footer'), document.querySelector('.skip-link')].filter(Boolean);
let lockedY = 0;

function openMenu() {
  lockedY = window.scrollY;
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  menuLabel.textContent = 'Close menu';
  document.documentElement.classList.add('menu-open');
  // Lock background scroll without losing position.
  document.body.style.position = 'fixed';
  document.body.style.top = `-${lockedY}px`;
  document.body.style.left = '0';
  document.body.style.right = '0';
  outside().forEach((el) => (el.inert = true));
  updateHeader();
  menu.querySelector('a')?.focus();
}

function closeMenu({ restoreFocus = true, restoreScroll = true } = {}) {
  if (menu.hidden) return;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  menuLabel.textContent = 'Open menu';
  document.documentElement.classList.remove('menu-open');
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.left = '';
  document.body.style.right = '';
  outside().forEach((el) => (el.inert = false));
  if (restoreScroll) window.scrollTo(0, lockedY);
  updateHeader();
  if (restoreFocus) toggle.focus();
}

if (toggle && menu) {
  toggle.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));

  menu.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    if (link.getAttribute('href') === '#contact' && /consult/i.test(link.textContent) && document.getElementById('consult')) return; // the dialog handles it
    e.preventDefault();
    closeMenu({ restoreFocus: false, restoreScroll: true });
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      target.scrollIntoView();
      target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the header while the menu is open.
      const items = [...header.querySelectorAll('a[href], button:not([disabled])')].filter(
        (el) => el.offsetParent !== null
      );
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  window.matchMedia('(min-width: 1081px)').addEventListener('change', (e) => {
    if (e.matches) closeMenu({ restoreFocus: false });
  });
}

/* ---------- Inquiry forms: only report "sent" when it really was ---------- */

function wireForm(form) {
  const status = form.querySelector('.inquiry__status');
  const submit = form.querySelector('[type="submit"]');
  const say = (msg, tone = 'info') => {
    status.textContent = msg;
    status.dataset.tone = tone;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const endpoint = form.dataset.endpoint;
    if (!endpoint) {
      say(status.dataset.notConnected, 'error');
      return;
    }
    submit.disabled = true;
    try {
      const r = await fetch(endpoint, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      form.reset();
      say(status.dataset.success, 'success');
    } catch {
      say(status.dataset.error, 'error');
    } finally {
      submit.disabled = false;
    }
  });
}
document.querySelectorAll('form.inquiry').forEach(wireForm);

/* ---------- Consultation dialog ---------- */

const consult = document.getElementById('consult');
const SEEN_KEY = 'je-consult-seen';
const remember = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* storage unavailable */ } };
const seen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; } };

function openConsult() {
  if (!consult || consult.open) return;
  if (menu && !menu.hidden) closeMenu({ restoreFocus: false, restoreScroll: true });
  remember();
  document.documentElement.classList.add('consult-open');
  consult.showModal();
  consult.querySelector('input[name="name"]')?.focus();
}

if (consult && typeof consult.showModal === 'function') {
  // Every "Book a consultation" style link opens the dialog instead of jumping to the contact form.
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href="#contact"]');
    if (!link || !/consult/i.test(link.textContent)) return;
    e.preventDefault();
    openConsult();
  });

  consult.addEventListener('close', () => document.documentElement.classList.remove('consult-open'));
  consult.querySelectorAll('[data-consult-close]').forEach((b) => b.addEventListener('click', () => consult.close()));
  // Click on the backdrop (outside the panel) closes it.
  consult.addEventListener('click', (e) => {
    if (e.target === consult) consult.close();
  });

  // Open once by itself, when a visitor has finished the tour and reaches the studio section.
  const studio = document.getElementById('studio');
  if (consult.dataset.auto === 'true' && studio && !seen() && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.isIntersecting)) return;
      io.disconnect();
      setTimeout(() => {
        if (!seen() && !document.documentElement.classList.contains('menu-open')) openConsult();
      }, 1200);
    }, { threshold: 0.25 });
    io.observe(studio);
  }
}

/* ---------- Section reveals ---------- */

const revealables = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.05 }
  );
  revealables.forEach((el) => io.observe(el));
} else {
  revealables.forEach((el) => el.classList.add('is-in'));
}

// Opened via an anchor (e.g. /#services): make sure everything above the fold is shown.
window.addEventListener('load', () => {
  if (location.hash) revealables.forEach((el) => {
    if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-in');
  });
});
