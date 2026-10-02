import './style.css';
import { Game } from './core/Game';
import { GameControls } from './core/controls';
import { mountHud } from './ui/hud';
import { AudioManager } from './audio/AudioManager';
import { loadGame, restoreGame, saveGame } from './core/Save';
import { useGameStore } from './state/store';

const app = document.querySelector<HTMLElement>('#app');
const hud = document.querySelector<HTMLElement>('#hud');
if (!app || !hud) throw new Error('Mount points #app and #hud are required');
restoreGame(loadGame());
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useGameStore.subscribe(() => {
  if (saveTimer !== undefined) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try { saveGame(); } catch { /* Local storage can be unavailable. */ }
  }, 500);
});
window.addEventListener('pagehide', () => { try { saveGame(); } catch { /* Local storage can be unavailable. */ } });
const audio = new AudioManager();
mountHud(hud, () => audio.toggle());
const game = new Game(app, 1337);
void game.start();
declare global { interface Window { __game: Game; __gameControls: GameControls } }
window.__game = game;
window.__gameControls = new GameControls(game);
