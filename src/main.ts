import './style.css';
import { Game } from './core/Game';
import { GameControls } from './core/controls';
import { mountHud } from './ui/hud';

const app = document.querySelector<HTMLElement>('#app');
const hud = document.querySelector<HTMLElement>('#hud');
if (!app || !hud) throw new Error('Mount points #app and #hud are required');
mountHud(hud);
const game = new Game(app, 1337);
void game.start();
declare global { interface Window { __game: Game; __gameControls: GameControls } }
window.__game = game;
window.__gameControls = new GameControls(game);
