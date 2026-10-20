/**
 * Beacon Defense HUD — the game's interface, built only from the engine's own UI framework
 * (`docs/UI-GUIDE.md`): retained-mode widgets, laid out by the UI layout engine and drawn by the
 * WebGPU UI overlay pass. No DOM, so it is exactly as testable on Node as it is in the browser.
 *
 * The HUD is presentation only. It never decides anything: the scene hands it a `BeaconHudSnapshot`
 * once a frame and it draws that, and every control calls back through `BeaconHudHandlers`, which the
 * scene turns into an event on the script runtime's host channel. Widgets used:
 *
 *  - `HealthBar` / `ResourceCounter` / `StatDisplay`  beacon integrity, score, credits, kills, leaks
 *  - `ObjectiveTracker`                               the wave's objective and the run's
 *  - `MinimapContainer`                               the arena, with a marker per drone (procedural map)
 *  - `Hotbar` + `AbilityButton` + `CooldownIndicator` the three abilities, with cost and cooldown
 *  - `Button`                                         six upgrades, the call-wave and pause controls
 *  - `TargetHealthDisplay`                            the drone closest to the beacon
 *  - `InteractionPrompt`, `Panel`, `Toasts`, `WorldSpaceLabel`
 */

import {
  AbilityButton,
  Button,
  HealthBar,
  Hotbar,
  InteractionPrompt,
  Label,
  MinimapContainer,
  ObjectiveTracker,
  Panel,
  ResourceCounter,
  Separator,
  Stack,
  StatDisplay,
  TargetHealthDisplay,
  Toasts,
  WorldSpaceLabel,
  type MapMarker,
  type UIManager,
  type WorldCamera,
  type WorldPoint,
} from "@forge/engine";
import { DRONE_SPECS, type AbilityId, type DroneKind, type UpgradeId } from "../scripting/beaconDefenseGame.js";

/** What the scene pushes into the HUD once a frame. All of it is already decided by the game. */
export interface BeaconHudSnapshot {
  wave: number;
  finalWave: number;
  phase: "combat" | "intermission" | "gameover" | "won";
  /** Seconds left in the intermission (0 outside one). */
  intermissionLeft: number;
  score: number;
  credits: number;
  kills: number;
  leaks: number;
  drones: number;
  /** Drones in the current wave, and how many of them are down. */
  waveDrones: number;
  waveKills: number;
  beaconHp: number;
  beaconMaxHp: number;
  turret: {
    damage: number;
    cannonDamage: number;
    /** Seconds between AI shots and between manual shots. */
    aiInterval: number;
    manualInterval: number;
    range: number;
    targets: number;
    shots: number;
    manualShots: number;
    hits: number;
  };
  upgrades: BeaconHudUpgradeRow[];
  abilities: BeaconHudAbilityRow[];
  markers: BeaconHudMarker[];
  arenaRadius: number;
  /** The drone closest to the beacon: what the player should shoot next. */
  threat: { name: string; hp: number; maxHp: number; level: number } | null;
  banner: { title: string; text: string } | null;
  end: { won: boolean; wave: number; score: number; kills: number; leaks: number; games: number } | null;
  hint: { key: string; action: string } | null;
  paused: boolean;
}

export interface BeaconHudUpgradeRow {
  id: UpgradeId;
  name: string;
  level: number;
  maxLevel: number;
  /** Credits for the next level, or `null` when maxed. */
  cost: number | null;
  affordable: boolean;
  hotkey: string;
}

export interface BeaconHudAbilityRow {
  id: AbilityId;
  name: string;
  icon: string;
  hotkey: string;
  cost: number;
  /** Seconds of cooldown left, and the cooldown's full length in seconds. */
  cooldownLeft: number;
  cooldownTotal: number;
  affordable: boolean;
  active: boolean;
}

export interface BeaconHudMarker {
  x: number;
  z: number;
  kind: DroneKind;
  slowed: boolean;
}

export interface BeaconHudHandlers {
  ability(id: AbilityId): void;
  upgrade(id: UpgradeId): void;
  callWave(): void;
  restart(): void;
  pause(): void;
}

export interface BeaconHudOptions {
  /** The camera the world-space label projects with (the renderer's, from last frame). */
  camera: () => WorldCamera;
  /** The point above the beacon the world-space label floats over. */
  beacon: () => WorldPoint;
}

export interface BeaconHud {
  /** Draw `snapshot`. Called once per frame after the game has stepped. */
  update(snapshot: BeaconHudSnapshot): void;
  toast(message: string, kind?: "info" | "success" | "warning" | "error"): void;
  /** The widgets this HUD is made of, for tests and diagnostics. */
  readonly widgets: number;
  /** The last snapshot drawn, so a test can assert the HUD is showing what the game said. */
  readonly last: BeaconHudSnapshot | null;
  readonly toasts: Toasts;
  readonly minimap: MinimapContainer;
  readonly hotbar: Hotbar;
  dispose(): void;
}

const MARKER_COLOR: Readonly<Record<DroneKind, string>> = {
  scout: "#fb923c",
  splitter: "#a78bfa",
  bruiser: "#f87171",
  bomber: "#facc15",
};
const SLOWED_COLOR = "#38bdf8";
const STEPS_PER_SECOND = 60;

/**
 * A procedural minimap: the arena disc, the spawn ring, the turret's reach and the beacon, painted
 * into RGBA8 pixels and registered as a UI sprite. Deterministic, and it needs no asset file.
 */
export function arenaMapPixels(size = 128, rings = [0.42, 0.68, 0.94]): { width: number; height: number; rgba: Uint8Array } {
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dz = (y - c) / c;
      const r = Math.hypot(dx, dz);
      const o = (y * size + x) * 4;
      if (r > 1) {
        rgba[o] = 6;
        rgba[o + 1] = 9;
        rgba[o + 2] = 14;
        rgba[o + 3] = 255;
        continue;
      }
      // Disc, faintly lit from the centre out.
      const shade = 26 + Math.round(18 * (1 - r));
      rgba[o] = shade;
      rgba[o + 1] = shade + 8;
      rgba[o + 2] = shade + 18;
      rgba[o + 3] = 255;
      for (const ring of rings) {
        if (Math.abs(r - ring) < 1.6 / size * 4) {
          rgba[o] = 64;
          rgba[o + 1] = 96;
          rgba[o + 2] = 118;
        }
      }
      // Cross hairs, so the disc reads as a map and not a blob.
      if (Math.abs(dx) < 1 / size || Math.abs(dz) < 1 / size) {
        rgba[o] = 52;
        rgba[o + 1] = 74;
        rgba[o + 2] = 92;
      }
      if (r < 0.07) {
        rgba[o] = 88;
        rgba[o + 1] = 196;
        rgba[o + 2] = 221;
      }
    }
  }
  return { width: size, height: size, rgba };
}

export function buildBeaconHud(ui: UIManager, handlers: BeaconHudHandlers, options: BeaconHudOptions): BeaconHud {
  const hud = ui.layer("hud");
  let widgets = 0;
  const count = <T>(w: T): T => {
    widgets++;
    return w;
  };

  const map = arenaMapPixels();
  ui.assets.registerPixels("beacon.arena", map.width, map.height, map.rgba);

  // ------------------------------------------------------------------ vitals (top left)
  const vitals = hud.add(count(new Panel({ gap: 6, name: "beacon-vitals" })));
  vitals.setLayout({ position: "absolute", anchor: { top: 14, left: 14 }, width: 276 });
  const vitalsHead = vitals.add(new Stack({ direction: "row", gap: 8, align: "center" }));
  const titleLabel = count(vitalsHead.add(new Label({ text: "BEACON DEFENSE", variant: "heading" })));
  titleLabel.setLayout({ flexGrow: 1, flexShrink: 1 });
  const pauseButton = count(vitalsHead.add(new Button({ text: "❚❚", onPress: () => handlers.pause(), tooltip: "Pause (P)" })));
  pauseButton.setLayout({ width: 40 });
  const integrity = count(vitals.add(new HealthBar({ max: 120, value: 120, lowThreshold: 0.3 })));
  integrity.setLayout({ height: 18 });
  const integrityLabel = count(vitals.add(new Label({ text: "integrity 120 / 120", variant: "caption" })));
  const resources = vitals.add(new Stack({ direction: "row", gap: 14, align: "center" }));
  const scoreCounter = count(resources.add(new ResourceCounter({ icon: "star", value: 0 })));
  const creditsCounter = count(resources.add(new ResourceCounter({ icon: "circle", value: 0 })));
  const stats = vitals.add(new Stack({ direction: "row", gap: 12 }));
  const killsStat = count(stats.add(new StatDisplay({ label: "kills", value: 0 })));
  const leaksStat = count(stats.add(new StatDisplay({ label: "leaks", value: 0 })));
  const waveStat = count(stats.add(new StatDisplay({ label: "wave", value: "1/12" })));
  vitals.add(count(new Separator()));
  const weaponLabel = count(vitals.add(new Label({ text: "turret —", variant: "caption", wrap: "word" })));
  const minimap = count(vitals.add(new MinimapContainer({ map: "beacon.arena", size: 148, zoom: 1, circular: true })));
  minimap.setLayout({ alignSelf: "center" });

  // ------------------------------------------------------------------ wave (top right)
  const wavePanel = hud.add(count(new Panel({ gap: 6, name: "beacon-wave" })));
  wavePanel.setLayout({ position: "absolute", anchor: { top: 14, right: 14 }, width: 258 });
  const waveLabel = count(wavePanel.add(new Label({ text: "WAVE 1", variant: "heading" })));
  const objectives = count(
    wavePanel.add(
      new ObjectiveTracker({
        objectives: [
          { id: "wave", text: "Destroy the wave", current: 0, target: 1 },
          { id: "hold", text: "Hold the beacon", current: 1, target: 1 },
          { id: "run", text: "Survive to wave 12", current: 1, target: 12 },
        ],
      }),
    ),
  );
  const intermissionLabel = count(wavePanel.add(new Label({ text: "", variant: "muted" })));
  const callWaveButton = count(wavePanel.add(new Button({ text: "CALL NEXT WAVE", variant: "primary", onPress: () => handlers.callWave() })));
  callWaveButton.visible = false;
  const threat = count(wavePanel.add(new TargetHealthDisplay()));
  threat.visible = false;

  // ------------------------------------------------------------------ abilities (bottom centre)
  const hotbar = count(
    hud.add(
      new Hotbar({
        name: "beacon-abilities",
        abilities: [
          { icon: "lightning", hotkey: "1", cooldown: 0, cost: 0, tooltip: "EMP pulse", onUse: () => handlers.ability("emp") },
          { icon: "swords", hotkey: "2", cooldown: 0, cost: 0, tooltip: "Overcharge", onUse: () => handlers.ability("overcharge") },
          { icon: "heart", hotkey: "3", cooldown: 0, cost: 0, tooltip: "Field repair", onUse: () => handlers.ability("repair") },
        ],
      }),
    ),
  );
  hotbar.setLayout({ position: "absolute", anchor: { bottom: 18, centerX: 0 } });
  const abilitySlots = new Map<AbilityId, AbilityButton>();
  hotbar.slots.forEach((slot, i) => {
    const id = (["emp", "overcharge", "repair"] as const)[i];
    if (id) abilitySlots.set(id, slot);
  });
  const abilityLabels = hud.add(count(new Stack({ direction: "row", gap: 10, name: "beacon-ability-names" })));
  abilityLabels.setLayout({ position: "absolute", anchor: { bottom: 4, centerX: 0 } });
  abilityLabels.pointerEvents = "none";
  const abilityCaptions = new Map<AbilityId, Label>();
  for (const id of ["emp", "overcharge", "repair"] as const) {
    abilityCaptions.set(id, count(abilityLabels.add(new Label({ text: id, variant: "caption" }))));
  }

  // ------------------------------------------------------------------ upgrades (bottom right)
  const upgradePanel = hud.add(count(new Panel({ gap: 4, name: "beacon-upgrades" })));
  upgradePanel.setLayout({ position: "absolute", anchor: { bottom: 14, right: 14 }, width: 262 });
  const upgradeTitle = count(upgradePanel.add(new Label({ text: "UPGRADES", variant: "heading" })));
  void upgradeTitle;
  const upgradeButtons = new Map<UpgradeId, Button>();
  for (const id of ["damage", "rate", "range", "multishot", "shield", "cooling"] as const) {
    const button = count(upgradePanel.add(new Button({ text: id, onPress: () => handlers.upgrade(id) })));
    button.setLayout({ alignSelf: "stretch" });
    upgradeButtons.set(id, button);
  }

  // ------------------------------------------------------------------ banner, hint, end panel
  const banner = hud.add(count(new Panel({ gap: 2, name: "beacon-banner" })));
  banner.setLayout({ position: "absolute", anchor: { top: 74, centerX: 0 }, padding: [8, 18] });
  banner.pointerEvents = "none";
  const bannerTitle = count(banner.add(new Label({ text: "", variant: "heading", align: "center" })));
  const bannerText = count(banner.add(new Label({ text: "", variant: "muted", align: "center" })));
  banner.visible = false;

  const hint = count(hud.add(new InteractionPrompt({ key: "Space", action: "Fire the cannon" })));
  hint.setLayout({ position: "absolute", anchor: { bottom: 92, centerX: 0 } });

  const endPanel = hud.add(count(new Panel({ gap: 8, name: "beacon-end" })));
  endPanel.setLayout({ position: "absolute", anchor: { centerX: 0, centerY: 0 }, width: 380, padding: [16, 20] });
  const endTitle = count(endPanel.add(new Label({ text: "GAME OVER", variant: "heading", align: "center" })));
  const endStats = count(endPanel.add(new Label({ text: "", variant: "muted", align: "center", wrap: "word" })));
  const endAgain = count(endPanel.add(new Button({ text: "PLAY AGAIN", variant: "primary", onPress: () => handlers.restart() })));
  endPanel.visible = false;

  const beaconLabel = count(new WorldSpaceLabel({ target: options.beacon, camera: options.camera, offsetY: 26 }));
  const beaconTag = beaconLabel.add(new Panel({ gap: 2 }));
  beaconTag.setLayout({ padding: [3, 8] });
  const beaconTagText = count(beaconTag.add(new Label({ text: "BEACON", variant: "strong" })));
  const beaconTagBar = beaconTag.add(new HealthBar({ value: 1, max: 1, showValues: false }));
  beaconTagBar.setLayout({ width: 96, height: 5 });
  hud.add(beaconLabel);

  const toasts = new Toasts(ui, "bottom-left");

  // Cooldown rings are started when an ability goes on cooldown and tick themselves down with
  // `ui.update(dt)`; the scene stops calling that while the game is paused, so they cannot drift.
  const cooling = new Map<AbilityId, boolean>();

  let last: BeaconHudSnapshot | null = null;

  const update = (s: BeaconHudSnapshot): void => {
    last = s;
    integrity.max = s.beaconMaxHp;
    integrity.value = s.beaconHp;
    integrityLabel.text = `integrity ${Math.round(s.beaconHp)} / ${Math.round(s.beaconMaxHp)}`;
    scoreCounter.value = s.score;
    creditsCounter.value = s.credits;
    killsStat.value = s.kills;
    leaksStat.value = s.leaks;
    waveStat.value = `${s.wave}/${s.finalWave}`;
    weaponLabel.text =
      `turret ${s.turret.damage.toFixed(1)} dmg / ${s.turret.aiInterval.toFixed(2)} s · cannon ${s.turret.cannonDamage.toFixed(1)} dmg / ` +
      `${s.turret.manualInterval.toFixed(2)} s · range ${s.turret.range.toFixed(0)} m · ${s.turret.targets} target${s.turret.targets > 1 ? "s" : ""}` +
      ` · ${s.turret.hits}/${s.turret.shots} hits`;
    pauseButton.text = s.paused ? "▶" : "❚❚";

    waveLabel.text = s.phase === "intermission" ? `WAVE ${s.wave} CLEARED` : `WAVE ${s.wave} — ${s.drones} DRONE${s.drones === 1 ? "" : "S"}`;
    objectives.setObjective({ id: "wave", text: `Destroy wave ${s.wave}`, current: s.waveKills, target: Math.max(1, s.waveDrones) });
    objectives.setObjective({ id: "hold", text: "Hold the beacon", current: s.beaconHp, target: s.beaconMaxHp, done: s.beaconHp > 0 });
    objectives.progress("run", Math.max(1, s.wave));
    const intermission = s.phase === "intermission";
    callWaveButton.visible = intermission;
    intermissionLabel.text = intermission
      ? `next wave in ${Math.max(0, s.intermissionLeft).toFixed(1)} s — spend your credits`
      : s.phase === "combat"
        ? `${s.waveKills}/${Math.max(1, s.waveDrones)} down`
        : "";
    intermissionLabel.visible = intermissionLabel.text.length > 0;

    threat.setTarget(s.threat ? { name: s.threat.name, level: s.threat.level, health: s.threat.hp, maxHealth: s.threat.maxHp } : null);

    // Minimap: drones, then the turret and the beacon, in map space 0..1 over the arena disc.
    const span = Math.max(1, s.arenaRadius);
    const markers: MapMarker[] = [];
    for (const m of s.markers) {
      markers.push({
        x: 0.5 + m.x / (2 * span),
        y: 0.5 + m.z / (2 * span),
        color: m.slowed ? SLOWED_COLOR : MARKER_COLOR[m.kind],
        clampToEdge: true,
      });
    }
    markers.push({ x: 0.5, y: 0.5, color: "#22d3ee", icon: "star" });
    minimap.setMarkers(markers);

    for (const row of s.abilities) {
      const slot = abilitySlots.get(row.id);
      const caption = abilityCaptions.get(row.id);
      if (!slot || !caption) continue;
      slot.cost = row.cost;
      slot.affordable = row.affordable;
      slot.enabled = row.affordable;
      const onCooldown = row.cooldownLeft > 0;
      if (onCooldown && !cooling.get(row.id)) {
        slot.cooldown.start(Math.max(0.05, row.cooldownTotal));
        cooling.set(row.id, true);
      } else if (!onCooldown && cooling.get(row.id)) {
        slot.cooldown.reset();
        cooling.set(row.id, false);
      }
      caption.text = `${row.hotkey} ${row.name}${row.active ? " · ACTIVE" : ""} · ${row.cost}¢`;
    }

    for (const row of s.upgrades) {
      const button = upgradeButtons.get(row.id);
      if (!button) continue;
      const maxed = row.cost === null;
      button.text = maxed
        ? `${row.name} ${row.level}/${row.maxLevel} — MAX`
        : `${row.hotkey}  ${row.name} ${row.level}/${row.maxLevel} — ${row.cost}¢`;
      button.enabled = !maxed && row.affordable;
    }

    if (s.banner) {
      banner.visible = true;
      bannerTitle.text = s.banner.title;
      bannerText.text = s.banner.text;
    } else {
      banner.visible = false;
    }
    if (s.hint) {
      hint.visible = true;
      hint.key = s.hint.key;
      hint.action = s.hint.action;
    } else {
      hint.visible = false;
    }
    if (s.end) {
      endPanel.visible = true;
      endTitle.text = s.end.won ? "BEACON HELD — VICTORY" : "BEACON LOST";
      endStats.text =
        `wave ${s.end.wave} of ${s.finalWave} · score ${s.end.score} · ${s.end.kills} kills · ${s.end.leaks} leaks\n` +
        `run ${s.end.games} — the drones regroup in a moment, or play again now`;
      endAgain.text = s.end.won ? "PLAY AGAIN" : "TRY AGAIN";
    } else {
      endPanel.visible = false;
    }
    beaconTagText.text = `${Math.round(s.beaconHp)} / ${Math.round(s.beaconMaxHp)}`;
    beaconTagBar.max = s.beaconMaxHp;
    beaconTagBar.value = s.beaconHp;
  };

  return {
    update,
    toast: (message, kind = "info") => {
      toasts.show(message, kind);
    },
    get widgets() {
      return widgets;
    },
    get last() {
      return last;
    },
    toasts,
    minimap,
    hotbar,
    dispose: () => {
      beaconLabel.dispose();
      hotbar.dispose();
      upgradePanel.dispose();
      wavePanel.dispose();
      vitals.dispose();
      banner.dispose();
      hint.dispose();
      endPanel.dispose();
      abilityLabels.dispose();
    },
  };
}

/** Fixed-step counts as the HUD's seconds, so cooldowns read the same as the game's. */
export const stepsToSeconds = (steps: number): number => steps / STEPS_PER_SECOND;

/** The drone specs, re-exported so the scene and the HUD share one source of names. */
export { DRONE_SPECS };
