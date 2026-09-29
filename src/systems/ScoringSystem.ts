import type { EventBus, GameEvents } from '../core/Events';
import { useGameStore } from '../state/store';
import { getTrapConfig } from '../entities/Trap';
import config from '../state/config/game.json';

export class ScoringSystem {
  private currencyUnsub?: () => void;
  private comboCount = 0;
  private lastKillTime = 0;
  private comboTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly events: EventBus<GameEvents>, private readonly hudRoot: HTMLElement) {
    this.bind();
  }

  dispose(): void {
    this.currencyUnsub?.();
    if (this.comboTimer) clearTimeout(this.comboTimer);
  }

  private bind(): void {
    this.events.on('goblin:tap', ({ reward }) => {
      this.registerKill(reward, 'tap');
    });
    this.events.on('goblin:grabbed', () => {
      this.registerKill(config.economy.earnPerGrab, 'grab');
    });
    this.events.on('trap:triggered', ({ trapId, reward }) => {
      const trap = getTrapConfig(trapId);
      const base = trap?.reward ?? reward;
      this.registerKill(base, 'trap', { trapId });
    });
  }

  private registerKill(baseReward: number, key: string, meta?: { trapId?: string }): void {
    const { multiplied, combo } = this.applyCombo(baseReward);
    useGameStore.getState().earn(multiplied);
    this.showPopup(key, multiplied, combo > 1 ? combo : 0, meta?.trapId);
    this.events.emit('combo:chain', { count: combo, multiplier: this.comboMultiplier(combo), reward: multiplied });
  }

  private applyCombo(baseReward: number): { multiplied: number; combo: number } {
    const now = performance.now();
    const windowMs = config.combo.windowSeconds * 1000;
    if (now - this.lastKillTime <= windowMs && this.comboCount > 0) {
      this.comboCount = Math.min(this.comboCount + 1, config.combo.maxCount);
    } else {
      this.comboCount = 1;
    }
    this.lastKillTime = now;
    this.scheduleComboReset();
    const multiplier = this.comboMultiplier(this.comboCount);
    return { multiplied: Math.round(baseReward * multiplier), combo: this.comboCount };
  }

  private comboMultiplier(combo: number): number {
    const idx = Math.min(Math.max(combo - 1, 0), config.combo.multipliers.length - 1);
    return config.combo.multipliers[idx] ?? 1;
  }

  private scheduleComboReset(): void {
    if (this.comboTimer) clearTimeout(this.comboTimer);
    this.comboTimer = setTimeout(() => {
      this.comboCount = 0;
    }, config.combo.windowSeconds * 1000);
  }

  private showPopup(key: string, amount: number, combo: number, trapId?: string): void {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.className = 'popup';
    const comboText = combo > 1 ? ` ${this.comboLabel(combo)}` : '';
    const bonkText = trapId === 'pan' ? ' BONK!' : '';
    el.textContent = `+${new Intl.NumberFormat('uk-UA').format(amount)}${comboText}${bonkText}`;
    el.style.cssText = 'position:absolute;left:50%;top:14%;transform:translateX(-50%);padding:8px 16px;border-radius:999px;background:#fff6db;box-shadow:0 4px 0 #bd8150;border:2px solid #fff4d4;color:#60462f;font-weight:900;pointer-events:none;animation:popup-rise 1.2s ease-out forwards;';
    const style = document.createElement('style');
    style.textContent = '@keyframes popup-rise{0%{opacity:1;transform:translateX(-50%) translateY(0) scale(1);}100%{opacity:0;transform:translateX(-50%) translateY(-40px) scale(1.15);}}';
    el.append(style);
    this.hudRoot.append(el);
    setTimeout(() => el.remove(), 1200);
  }

  private comboLabel(combo: number): string {
    const titles: Record<number, string> = { 2: 'combo_x2', 3: 'combo_x3', 4: 'combo_x4' };
    return combo > 1 ? `Комбо ×${combo}` : '';
  }
}
