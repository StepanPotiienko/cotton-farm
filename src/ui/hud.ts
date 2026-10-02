import { t } from '../core/i18n';
import { useGameStore } from '../state/store';
import { getTrapConfig, isTrapUnlocked } from '../entities/Trap';
import type { ShopSystem } from '../systems/ShopSystem';
import type { TrapConfig } from '../entities/Trap';
import config from '../state/config/game.json';

let shopSystem: ShopSystem | null = null;
let rootRef: HTMLElement | null = null;
let selectTrap: ((trapId: string) => boolean) | null = null;

export function setShopSystem(system: ShopSystem, onSelectTrap?: (trapId: string) => boolean): void {
  shopSystem = system;
  selectTrap = onSelectTrap ?? null;
}

export function mountHud(root: HTMLElement, onMusicToggle?: () => boolean): void {
  rootRef = root;
  root.innerHTML = `
    <header class="hud-bar"><strong class="brand">${t('title')}</strong><div class="hud-actions"><div class="currency" aria-live="polite"><span class="coin">✿</span><span id="currency-value">0</span><small>${t('currency')}</small></div><button class="hud-button" id="hud-music" type="button" aria-pressed="false">${t('music_off')}</button><button class="hud-button" id="hud-borshch" type="button">${t('borshch')}</button><button class="hud-button" id="hud-shop" type="button">${t('shop')}</button><button class="hud-button" id="hud-settings" type="button">${t('settings')}</button></div></header>
    <div class="hint">${t('hint')}</div>
    <div id="borshch-panel" class="borshch-panel" role="dialog" aria-modal="true" aria-labelledby="borshch-title" hidden>
      <div class="borshch-header"><strong id="borshch-title">${t('borshch')}</strong><button class="hud-button" id="borshch-close" type="button" aria-label="${t('borshch')} — close">×</button></div>
      <div class="borshch-body">
        <progress id="borshch-progress" max="100" value="0" aria-label="${t('borshch')}"></progress>
        <span id="borshch-status" aria-live="polite">0%</span>
        <button class="hud-button" id="borshch-sell" type="button" disabled>${t('borshch_ready')}</button>
      </div>
    </div>
    <div id="settings-panel" class="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden><strong id="settings-title">${t('settings')}</strong><p>${t('settings_credit')}</p><button class="hud-button" id="settings-close" type="button" aria-label="${t('settings')} — close">×</button></div>
    <div id="shop-modal" class="shop-modal" role="dialog" aria-modal="true" aria-labelledby="shop-title" hidden>
      <div class="shop-panel">
        <div class="shop-header"><strong id="shop-title">${t('shop')}</strong><button class="hud-button" id="shop-close" type="button" aria-label="${t('shop')} — close">×</button></div>
        <div class="shop-tabs" role="tablist"><button class="shop-tab active" type="button" role="tab" aria-selected="true" data-tab="traps">${t('traps')}</button><button class="shop-tab" type="button" role="tab" aria-selected="false" data-tab="farm">${t('farm')}</button><button class="shop-tab" type="button" role="tab" aria-selected="false" data-tab="decor">${t('decor')}</button><button class="shop-tab" type="button" role="tab" aria-selected="false" data-tab="pets">${t('pets')}</button><button class="shop-tab" type="button" role="tab" aria-selected="false" data-tab="skins">${t('skins')}</button></div>
        <div class="shop-body" id="shop-body"></div>
      </div>
    </div>
  `;
  const currency = root.querySelector('#currency-value');
  const progress = root.querySelector('#borshch-progress') as HTMLProgressElement | null;
  const status = root.querySelector('#borshch-status');
  const sell = root.querySelector('#borshch-sell') as HTMLButtonElement | null;
  const update = () => {
    const state = useGameStore.getState();
    if (currency) currency.textContent = new Intl.NumberFormat('uk-UA').format(state.currency);
    const percent = Math.round(state.cookingProgress * 100);
    if (progress) progress.value = percent;
    if (status) status.textContent = `${percent}%`;
    if (sell) sell.disabled = percent < 100;
  };
  update();
  useGameStore.subscribe(update);

  const musicButton = root.querySelector('#hud-music');
  musicButton?.addEventListener('click', () => {
    const enabled = onMusicToggle?.() ?? false;
    musicButton.textContent = enabled ? t('music_on') : t('music_off');
    musicButton.setAttribute('aria-pressed', String(enabled));
  });

  sell?.addEventListener('click', () => { useGameStore.getState().sellBorshch(); update(); });

  const borshchPanel = root.querySelector('#borshch-panel') as HTMLElement | null;
  const borshchButton = root.querySelector('#hud-borshch');
  const borshchClose = root.querySelector('#borshch-close');
  borshchButton?.addEventListener('click', () => { if (borshchPanel) borshchPanel.hidden = false; });
  borshchClose?.addEventListener('click', () => { if (borshchPanel) borshchPanel.hidden = true; });

  const settingsPanel = root.querySelector('#settings-panel') as HTMLElement | null;
  root.querySelector('#hud-settings')?.addEventListener('click', () => { if (settingsPanel) settingsPanel.hidden = false; });
  root.querySelector('#settings-close')?.addEventListener('click', () => { if (settingsPanel) settingsPanel.hidden = true; });

  const shopButton = root.querySelector('#hud-shop');
  const modal = root.querySelector('#shop-modal');
  const closeButton = root.querySelector('#shop-close');
  shopButton?.addEventListener('click', () => {
    if (modal) (modal as HTMLElement).hidden = false;
    renderShopTab('traps');
  });
  closeButton?.addEventListener('click', () => {
    if (modal) (modal as HTMLElement).hidden = true;
  });

  [modal, settingsPanel, borshchPanel].forEach((dialog) => dialog?.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') (dialog as HTMLElement).hidden = true;
  }));

  const tabs = root.querySelectorAll('.shop-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tabs.forEach((t) => t.setAttribute('aria-selected', 'false'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      renderShopTab((tab as HTMLElement).dataset.tab ?? 'traps');
    });
  });

  injectShopStyles();
}

function injectShopStyles(): void {
  if (document.getElementById('shop-styles')) return;
  const style = document.createElement('style');
  style.id = 'shop-styles';
  style.textContent = `
    .borshch-panel:not([hidden]) { position: fixed; bottom: max(16px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%); width: min(480px, calc(100vw - 24px)); background: #fff6db; border: 3px solid #fff4d4; border-radius: 20px; box-shadow: 0 8px 0 #bd8150; pointer-events: auto; z-index: 12; }
    .borshch-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 2px solid #ffe9be; }
    .borshch-header strong { font-size: 18px; color: #543b29; font-weight: 900; }
    .borshch-header .hud-button { position: absolute; top: 6px; right: 6px; min-width: 44px; min-height: 44px; padding: 8px; }
    .borshch-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
    .borshch-body progress { width: 100%; height: 24px; border-radius: 12px; border: 2px solid #ffe9be; background: #fff; appearance: none; -webkit-appearance: none; }
    .borshch-body progress::-webkit-progress-bar { background: #fff; border-radius: 10px; }
    .borshch-body progress::-webkit-progress-value { background: linear-gradient(90deg, #df9842, #f5bb78); border-radius: 10px; }
    .borshch-body progress::-moz-progress-bar { background: linear-gradient(90deg, #df9842, #f5bb78); border-radius: 10px; }
    .borshch-body span { text-align: center; font-weight: 700; color: #543b29; font-size: 14px; }
    .borshch-body .hud-button { width: 100%; padding: 10px; }
    #hud:has(#borshch-panel:not([hidden])) .hint { bottom: max(160px, calc(env(safe-area-inset-bottom) + 160px)); }
    @media (max-width: 560px) { .borshch-panel:not([hidden]) { width: calc(100vw - 24px); } }
    .shop-modal:not([hidden]) { position: fixed; inset: 0; background: #493b2d66; display: flex; align-items: center; justify-content: center; pointer-events: auto; z-index: 10; padding: max(12px, env(safe-area-inset-top)) max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left)); }
    .shop-panel { background: #fff6db; border: 3px solid #fff4d4; border-radius: 20px; box-shadow: 0 8px 0 #bd8150; width: min(520px, 100%); max-height: min(80vh, 720px); max-height: min(80dvh, 720px); overflow: hidden; display: flex; flex-direction: column; }
    .shop-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 2px solid #ffe9be; }
    .shop-header strong { font-size: 20px; color: #543b29; }
    .shop-tabs { display: flex; gap: 6px; padding: 10px 14px; border-bottom: 2px solid #ffe9be; overflow-x: auto; }
    .shop-tab { border: 2px solid #fff4d4; background: #fff6db; color: #60462f; border-radius: 999px; padding: 7px 13px; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap; }
    .shop-tab.active { background: #ffe98a; border-color: #df9842; color: #543b29; }
    .shop-body { padding: 14px; overflow-y: auto; }
    .shop-grid { display: grid; gap: 10px; }
    .shop-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 2px solid #ffe9be; border-radius: 14px; background: #fff; }
    .shop-item-info { display: flex; flex-direction: column; gap: 2px; }
    .shop-item-name { font-weight: 900; color: #543b29; }
    .shop-item-desc { font-size: 12px; color: #8b7048; }
    .shop-cost { font-weight: 800; color: #60462f; }
    .shop-buy { pointer-events: auto; cursor: pointer; border: 2px solid #fff4d4; background: #ffe98a; color: #543b29; border-radius: 999px; padding: 8px 14px; font: inherit; font-weight: 800; }
    .shop-buy:disabled { background: #e8e0cc; color: #9e9585; cursor: not-allowed; }
    .shop-buy.owned { background: #a9b77c; color: #fff; }
    .shop-empty { color: #8b7048; text-align: center; padding: 20px; }
    .settings-panel:not([hidden]) { position: fixed; z-index: 11; top: max(72px, calc(env(safe-area-inset-top) + 64px)); right: max(16px, env(safe-area-inset-right)); width: min(340px, calc(100vw - 24px)); padding: 18px; border-radius: 16px; background: #fff6db; box-shadow: 0 6px 0 #bd8150; pointer-events: auto; }
    .settings-panel .hud-button { position: absolute; top: 8px; right: 8px; min-width: 44px; min-height: 44px; }
    .shop-tab:focus-visible, .shop-buy:focus-visible, .hud-button:focus-visible { outline: 3px solid #493b2d; outline-offset: 3px; }
    @media (max-width: 420px) { .shop-item { align-items: flex-start; } .shop-item > div:last-child { flex-direction: column; align-items: flex-end !important; gap: 5px !important; } }
  `;
  document.head.append(style);
}

function renderShopTab(tab: string): void {
  const body = rootRef?.querySelector('#shop-body');
  const shopModal = rootRef?.querySelector('#shop-modal') as HTMLElement | null;
  if (!body) return;
  if (tab === 'traps') {
    const traps = config.traps as TrapConfig[];
    body.innerHTML = `
      <div class="shop-grid">
        ${traps.map((trap) => {
          const unlocked = isTrapUnlocked(trap.id);
          const affordable = useGameStore.getState().currency >= trap.cost;
          return `
            <div class="shop-item" data-trap="${trap.id}">
              <div class="shop-item-info">
                <span class="shop-item-name">${t(trap.nameKey as Parameters<typeof t>[0])}</span>
                <span class="shop-item-desc">${t('radius')}: ${trap.triggerRadius} • ${t('reward')}: ${trap.reward}</span>
              </div>
              <div style="display:flex;align-items:center;gap:10px;">
                <span class="shop-cost">${trap.cost} ${t('currency')}</span>
                <button class="shop-buy${unlocked ? ' owned' : ''}" type="button" data-trap="${trap.id}" ${!unlocked && !affordable ? 'disabled' : ''} ${unlocked ? 'aria-label="Select trap for placement"' : ''}>
                  ${unlocked ? t('owned') : t('buy')}
                </button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    body.querySelectorAll('.shop-buy').forEach((button) => {
      button.addEventListener('click', () => {
        const trapId = (button as HTMLElement).dataset.trap;
        if (!trapId || !shopSystem) return;
        if (isTrapUnlocked(trapId)) {
          if (selectTrap?.(trapId)) {
            if (shopModal) shopModal.hidden = true;
          }
          return;
        }
        if (shopSystem.buyTrap(trapId)) {
          renderShopTab('traps');
          if (selectTrap?.(trapId) && shopModal) shopModal.hidden = true;
        }
      });
    });
  } else if (tab === 'farm') {
    renderLandTab(body, shopModal);
  } else if (tab === 'decor') {
    body.innerHTML = `<div class="shop-item"><div class="shop-item-info"><span class="shop-item-name">🌳 ${t('decor_tree')}</span><span class="shop-item-desc">${t('decor_description')}</span></div><span class="shop-cost">${t('land_bought')}</span></div>`;
  } else {
    body.innerHTML = `<div class="shop-empty">${t('coming_soon')}</div>`;
  }
}

function renderLandTab(body: Element, shopModal: HTMLElement | null): void {
  const state = useGameStore.getState();
  const lands = ['goblin', 'orc'].flatMap((side) =>
    Array.from({ length: 10 }, (_, index) => `${side}-${index + 1}`),
  );
  body.innerHTML = `
    <div class="shop-grid">
      <p class="shop-item-desc">${t('land_progress')}: ${state.destroyedCounts.goblin}/10 · ${state.destroyedCounts.orc}/10</p>
      ${lands.map((id) => {
        const side = id.startsWith('goblin') ? 'goblin' : 'orc';
        const index = Number(id.split('-')[1]);
        const unlocked = state.eligibleLand.includes(id);
        const owned = state.purchasedLand.includes(id);
        const previousDestroyed = index === 1 || state.destroyedBases.includes(`${side}-${index - 1}`);
        const label = owned ? t('land_bought') : unlocked ? t('land_available') : t('land_locked');
        const disabled = !unlocked || owned || !shopSystem || state.currency < config.cottonAttack.landCost;
        return `<div class="shop-item"><div class="shop-item-info"><span class="shop-item-name">${side === 'goblin' ? '🌿' : '⚒️'} ${t('land')} ${index}</span><span class="shop-item-desc">${label}${previousDestroyed ? '' : ` · ${t('land_locked')}`}</span></div><div style="display:flex;align-items:center;gap:10px;"><span class="shop-cost">${owned ? '✓' : `${config.cottonAttack.landCost} ${t('currency')}`}</span><button class="shop-buy${owned ? ' owned' : ''}" type="button" data-land="${id}" ${disabled ? 'disabled' : ''}>${owned ? t('owned') : t('buy')}</button></div></div>`;
      }).join('')}
    </div>
  `;
  body.querySelectorAll<HTMLButtonElement>('[data-land]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.land;
      if (id && shopSystem?.buyLand(id)) renderLandTab(body, shopModal);
    });
  });
}
