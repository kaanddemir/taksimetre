import { createLed, type Led } from "./led.ts";
import { STRINGS, type Lang } from "./i18n.ts";
import { viewModel, type ButtonVM, type ViewModel } from "./view-model.ts";
import type { MeterStore } from "./store.ts";
import { nextPref, setThemePref, themePref, type ThemePref } from "./theme.ts";

export interface AppOptions {
  /** False when live GPS is unavailable: the start action is disabled. */
  liveAvailable: boolean;
  lang: Lang;
  onLangChange?: (lang: Lang) => void;
  /** Overrides for key actions (the GPS layer wraps start/resume and adds cancel/reconnect). */
  actions?: Partial<Record<ButtonVM["action"], () => void>>;
  /** Build id of the installed offline version, shown in the info panel (production only). */
  version?: () => Promise<string | null>;
}

const CLOCK_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 6.5V12l3.5 2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

const WARN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.5 22 20.5H2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.6" r="1.2" fill="currentColor"/></svg>';

const INFO_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.4" r="1.3" fill="currentColor"/></svg>';

// The theme toggle shows the selected preference, like TR/EN shows the current language.
const THEME_ICON: Record<ThemePref, string> = {
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  system: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor"/></svg>',
};

/** DOM writes only when the value changes (render runs every 250 ms). */
function text(e: Element, v: string): void {
  if (e.textContent !== v) e.textContent = v;
}
function attr(e: Element, k: string, v: string): void {
  if (e.getAttribute(k) !== v) e.setAttribute(k, v);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function mountApp(root: HTMLElement, store: MeterStore, opts: AppOptions): { render(): void } {
  let lang = opts.lang;

  const meter = el("section", "meter");
  meter.setAttribute("aria-labelledby", "fare-text");

  const fareLed: Led = createLed(6, "led-fare");
  const fareLabel = el("div", "lbl fare-label");
  fareLabel.setAttribute("aria-hidden", "true");
  const fareRow = el("div", "fare-row");
  fareRow.append(fareLed.el, el("span", "unit unit-tl", "₺"));
  fareRow.setAttribute("aria-hidden", "true");
  const fareText = el("p", "sr-only");
  fareText.id = "fare-text";

  const legends = el("div", "legends");
  legends.setAttribute("aria-hidden", "true");
  const legendEls = {
    serbest: el("span", "legend", "SERBEST"),
    seyir: el("span", "legend", "SEYİR"),
    bekleme: el("span", "legend", "BEKLEME"),
    ucret: el("span", "legend", "ÜCRET"),
  };
  legends.append(...Object.values(legendEls));

  const tariff = el("div", "tariff");
  const tariffLbl = el("span", "lbl");
  const tariffLed = createLed(1, "led-tariff");
  const catName = el("span", "cat");
  tariff.append(tariffLbl, tariffLed.el, catName);
  tariffLbl.setAttribute("aria-hidden", "true");
  tariffLed.el.setAttribute("aria-hidden", "true");

  const trip = el("div", "trip");
  trip.setAttribute("aria-hidden", "true");
  const kmLed = createLed(5, "led-trip");
  const timeLed = createLed(5, "led-trip");
  const kmRow = el("div", "trip-row");
  kmRow.append(kmLed.el, el("span", "unit", "km"));
  const timeRow = el("div", "trip-row");
  const clockIcon = el("span", "unit unit-icon");
  clockIcon.innerHTML = CLOCK_ICON;
  timeRow.append(timeLed.el, clockIcon);
  trip.append(kmRow, timeRow);
  const tripText = el("p", "sr-only");

  const fareBlock = el("div", "fare");
  fareBlock.append(fareLabel, fareRow);
  meter.append(fareBlock, fareText, legends, tariff, trip, tripText);

  // Single notice slot: a plain info line or a short, non-interactive warning.
  const notice = el("div", "notice");
  notice.setAttribute("aria-live", "polite");
  const info = el("span", "notice-info");
  const warn = el("span", "warn");
  const warnIcon = el("span", "warn-icon");
  warnIcon.innerHTML = WARN_ICON;
  const warnText = el("span", "warn-text");
  warn.append(warnIcon, warnText);
  notice.append(info, warn);
  const controls = el("div", "controls");
  const secondary = el("button", "key");
  const primary = el("button", "key key-primary");
  secondary.type = primary.type = "button";
  controls.append(secondary, primary);

  const footer = el("footer", "foot");
  // General notice (estimate; GPS interruptions may affect accuracy) for assistive tech; not drawn on the meter face.
  const disclaimer = el("span", "sr-only");
  // Plain text toggle: shows the current language, one tap switches to the other.
  const langBtn = el("button", "lang");
  langBtn.type = "button";
  // Unboxed icon toggle beside the language toggle: one tap cycles System → Light → Dark.
  const themeBtn = el("button", "lang theme");
  themeBtn.type = "button";
  let shownPref: ThemePref | null = null;
  // Quiet product name on the far left; a tap opens the info panel (estimate, not certified, GPS limits, privacy).
  const brand = el("button", "brand");
  brand.type = "button";
  brand.setAttribute("aria-haspopup", "dialog");
  const brandIcon = el("span", "brand-icon");
  brandIcon.innerHTML = INFO_ICON;
  brand.append(el("span", "brand-name", "Taksimetre"), brandIcon);
  footer.append(brand, disclaimer, themeBtn, langBtn);

  // Opened only on request; modal so focus stays inside, Esc or KAPAT closes. The meter keeps running behind it.
  const infoDialog = el("dialog", "info");
  infoDialog.setAttribute("aria-labelledby", "info-title");
  const infoTitle = el("h2", "info-title");
  infoTitle.id = "info-title";
  const infoBody = el("div", "info-body");
  const infoMeta = el("p", "info-meta");
  const infoForm = el("form", "info-actions");
  infoForm.method = "dialog";
  const closeBtn = el("button", "key");
  infoForm.append(closeBtn);
  infoDialog.append(infoTitle, infoBody, infoMeta, infoForm);

  const announcer = el("div", "sr-only");
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");

  root.replaceChildren(meter, notice, controls, footer, announcer, infoDialog);

  const actions: Record<ButtonVM["action"], () => void> = {
    category: () => store.cycleCategory(),
    start: () => store.start(),
    finish: () => store.requestFinish(),
    resume: () => store.resume(),
    clear: () => store.clear(),
    cancel: () => undefined,
    reconnect: () => undefined,
    ...opts.actions,
  };
  // Buttons dispatch whatever action they currently show; the engine rejects anything invalid.
  for (const b of [secondary, primary]) b.addEventListener("click", () => actions[b.dataset.action as ButtonVM["action"]]?.());
  langBtn.addEventListener("click", () => {
    lang = lang === "tr" ? "en" : "tr";
    document.documentElement.lang = lang;
    opts.onLangChange?.(lang);
    render();
  });

  brand.addEventListener("click", () => {
    const t = STRINGS[lang];
    text(infoTitle, t.infoTitle);
    infoBody.replaceChildren(...t.info.map((p) => el("p", "", p)));
    const tariff = store.tariffFor(store.get().category);
    const decisionNo = tariff && /(\d+)\s*$/.exec(tariff.source.decision)?.[1];
    const meta = tariff && decisionNo ? [t.infoTariff(decisionNo, tariff.effectiveFrom)] : [];
    text(infoMeta, meta.join(" · "));
    text(closeBtn, t.close);
    infoDialog.showModal();
    void opts.version?.().then((v) => v && infoDialog.open && text(infoMeta, [...meta, t.infoVersion(v)].join(" · ")));
  });

  // A click on the dimmed backdrop (outside the panel's box) closes it, like Esc and KAPAT.
  infoDialog.addEventListener("click", (e) => {
    const r = infoDialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (e.target === infoDialog && !inside) infoDialog.close();
  });

  themeBtn.addEventListener("click", () => {
    setThemePref(nextPref(themePref())); // presentation only: the store and journey are not touched
    render();
  });

  function paintNotice(vm: ViewModel["notice"]): void {
    // Only on change: re-setting `hidden` still mutates the DOM, and render runs every 250 ms.
    if (info.hidden !== (vm.kind !== "info")) info.hidden = vm.kind !== "info";
    if (warn.hidden !== (vm.kind !== "warn")) warn.hidden = vm.kind !== "warn";
    text(info, vm.kind === "info" ? vm.text : "");
    text(warnText, vm.kind === "warn" ? vm.text : "");
  }


  function paintButton(b: HTMLButtonElement, vm: ButtonVM): void {
    attr(b, "data-action", vm.action);
    text(b, vm.label);
    if (b.disabled !== !vm.enabled) b.disabled = !vm.enabled;
    b.classList.toggle("armed", vm.armed);
    attr(b, "aria-label", vm.ariaLabel);
  }

  let lastStatus: ViewModel["status"] | null = null;
  function announce(vm: ViewModel): void {
    if (lastStatus === null || lastStatus === vm.status) {
      lastStatus = vm.status;
      return;
    }
    const t = STRINGS[lang];
    if (vm.status === "MESGUL") announcer.textContent = `${lastStatus === "UCRET" ? t.srResumed : t.srStarted}${store.get().gps === "live" ? `. ${t.srGpsReady}` : ""}`;
    else if (vm.status === "UCRET") announcer.textContent = t.srFinished(vm.fareText.replace(/^[^0-9]*/, ""));
    else announcer.textContent = t.srCleared;
    lastStatus = vm.status;
  }

  function render(): void {
    store.expireArm();
    const vm = viewModel(store.get(), store.now(), lang, opts.liveAvailable, (c) => store.tariffFor(c));
    const t = STRINGS[lang];
    attr(root, "data-status", vm.status);
    text(fareLabel, vm.fareLabel);
    fareLed.set(vm.fareLed);
    text(fareText, vm.fareText);
    for (const [k, e] of Object.entries(legendEls)) e.classList.toggle("on", vm.legends[k as keyof ViewModel["legends"]]);
    text(tariffLbl, t.tariff);
    tariffLed.set(vm.tariffDigit);
    text(catName, vm.categoryName);
    kmLed.set(vm.kmLed);
    timeLed.set(vm.timeLed);
    text(tripText, vm.status === "SERBEST" ? "" : vm.tripText);
    paintNotice(vm.notice);
    paintButton(secondary, vm.secondary);
    paintButton(primary, vm.primary);
    text(disclaimer, t.disclaimer);
    text(langBtn, t.langCode);
    attr(langBtn, "aria-label", t.langSwitchLabel);
    attr(langBtn, "lang", lang === "tr" ? "en" : "tr"); // the label is written in the target language
    attr(brand, "aria-label", t.infoOpen);
    const p = themePref();
    if (p !== shownPref) {
      themeBtn.innerHTML = THEME_ICON[p];
      shownPref = p;
    }
    attr(themeBtn, "aria-label", t.themeLabel(t.themeNames[p], t.themeNames[nextPref(p)]));
    announce(vm);
  }

  store.subscribe(render);
  window.setInterval(render, 250); // countdowns and arm expiry; values still come from the engine
  render();
  return { render };
}
