import { t } from '../core/i18n';
import { useGameStore } from '../state/store';
import { getTrapConfig, isTrapUnlocked } from '../entities/Trap';
import type { ShopSystem } from '../systems/ShopSystem';
import type { TrapConfig } from '../entities/Trap';
import config from '../state/config/game.json';

let shopSystem: ShopSystem | null = null;
let rootRef: HTMLElement | null = null;

export function setShopSystem(system: ShopSystem): void {
  shopSystem = system;
}

export function mountHud(root: HTMLElement): void {
  rootRef = root;
  root.innerHTML = `
    <header class="hud-bar"><strong class="brand">${t('title')}</strong><div class="hud-actions"><div class="currency" aria-live="polite"><span class="coin">✿</span><span id="currency-value">0</span><small>${t('currency')}</small></div><button class="hud-button" id="hud-shop" type="button">${t('shop')}</button><button class="hud-button" type="button">${t('settings')}</button></div></header>
    <div class="hint">${t('hint')}</div>
    <div id="shop-modal" class="shop-modal" style="display:none;">
      <div class="shop-panel">
        <div class="shop-header"><strong>${t('shop')}</strong><button class="hud-button" id="shop-close" type="button">×</button></div>
        <div class="shop-tabs"><button class="shop-tab active" data-tab="traps">${t('traps')}</button><button class="shop-tab" data-tab="farm">${t('farm')}</button><button class="shop-tab" data-tab="decor">${t('decor')}</button><button class="shop-tab" data-tab="pets">${t('pets')}</button><button class="shop-tab" data-tab="skins">${t('skins')}</button></div>
        <div class="shop-body" id="shop-body"></div>
      </div>
    </div>
  `;
  const currency = root.querySelector('#currency-value');
  const update = () => { if (currency) currency.textContent = new Intl.NumberFormat('uk-UA').format(useGameStore.getState().currency); };
  update();
  useGameStore.subscribe(update);

  const shopButton = root.querySelector('#hud-shop');
  const modal = root.querySelector('#shop-modal');
  const closeButton = root.querySelector('#shop-close');
  shopButton?.addEventListener('click', () => {
    if (modal) (modal as HTMLElement).style.display = 'flex';
    renderShopTab('traps');
  });
  closeButton?.addEventListener('click', () => {
    if (modal) (modal as HTMLElement).style.display = 'none';
  });

  const tabs = root.querySelectorAll('.shop-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
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
    .shop-modal { position: fixed; inset: 0; background: #493b2d66; display: flex; align-items: center; justify-content: center; pointer-events: auto; z-index: 10; }
    .shop-panel { background: #fff6db; border: 3px solid #fff4d4; border-radius: 20px; box-shadow: 0 8px 0 #bd8150; width: min(520px, calc(100% - 32px)); max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; }
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
  `;
  document.head.append(style);
}

function renderShopTab(tab: string): void {
  const body = rootRef?.querySelector('#shop-body');
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
                <button class="shop-buy" type="button" data-trap="${trap.id}" ${unlocked || !affordable ? 'disabled' : ''}>
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
        shopSystem.buyTrap(trapId);
        renderShopTab('traps');
      });
    });
  } else {
    body.innerHTML = `<div class="shop-empty">${t('coming_soon')}</div>`;
  }
}
