// ==UserScript==
// @name         OGameX Assistant
// @namespace    https://github.com/cthae/OgameX-Bot
// @version      2.99.2
// @description  Bot for OgameX
// @author       cth
// @match        https://*.ogamex.net/*
// @updateURL    https://github.com/cthae/OgameX-Bot/raw/refs/heads/main/ogamex-bot.user.js
// @downloadURL  https://github.com/cthae/OgameX-Bot/raw/refs/heads/main/ogamex-bot.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      generativelanguage.googleapis.com
// @connect      ntfy.sh
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

// ── v2.92.0: capture the ORIGINAL GM_* at the sandbox level ──
// Must sit BEFORE the IIFE: inside the IIFE those names shadow the prefixed consts,
// so the originals are no longer visible there (TDZ won't let you grab them inside).
const __gmGetRaw = GM_getValue;
const __gmSetRaw = GM_setValue;

(function () {
  "use strict";

  // ═══════════════════════════════════════════════════════════════
  //  PER-UNIVERSE STORAGE ISOLATION  (v2.92.0 — fix for the dead v2.9.0)
  // ═══════════════════════════════════════════════════════════════
  // v2.9.0 overwrote window.GM_setValue/getValue, but in the Tampermonkey
  // sandbox bare GM_* identifiers resolve in the sandbox scope,
  // NOT via window — the override was dead and ALL universes
  // shared one unprefixed store. Discovered 14.08.2026: the bot on
  // a fresh Vega account was reading the config, farm queue and
  // Athena counters (and could overwrite them). Now we shadow GM_getValue /
  // GM_setValue with consts INSIDE the IIFE — every existing call
  // in the bot hits these wrappers lexically, without touching window.
  // ── UNI-ISO-START ──
  const HOST = location.host;
  const GM_setValue = (key, value) => __gmSetRaw(`${HOST}:${key}`, value);
  const GM_getValue = (key, defaultValue) => {
    const v = __gmGetRaw(`${HOST}:${key}`, undefined);
    if (v !== undefined) return v;
    // Migration: Athena data lives in old, NON-prefixed keys
    // (the isolation never worked) — we read them ONLY on Athena; every
    // write already lands under a prefixed key, so the prefix gradually
    // takes over everything. Other universes start with a clean slate (bot OFF).
    if (HOST === "athena.ogamex.net") {
      return __gmGetRaw(key, defaultValue);
    }
    return defaultValue;
  };
  // ── UNI-ISO-END ──

  // ═══════════════════════════════════════════════════════════════
  //  CONFIGURATION (persistent via GM_setValue/GM_getValue, per-host)
  // ═══════════════════════════════════════════════════════════════

  const DEFAULT_CONFIG = {
    enabled: false,
    // ── v2.69.0: MOON MODE (owner's decision 05.08 after the attack) ──
    // The Phalanx only scans PLANETS: flights to/from the planet are visible to the second
    // (the attacker set the attack "one second" after the expedition's return), flights
    // to/from the MOON are invisible, and the moon can't be scanned.
    // "moon" = every routine dispatch (mining, expeditions, debris) launches
    // from the base's moon: before the form the bot switches the active body, and
    // miner rotation across colonies is disabled. The fleet, miners, recyclers
    // and deuterium should LIVE on the moon (ferry from the planet manually: RESCUE).
    baseBody: "moon",
    // ── v2.83.0: FERRY behind a toggle, OFF BY DEFAULT ──
    // Owner's decision 12.08: the bot does NOT move the fleet on its own —
    // 08:48 the ferry, right after launch, hauled the whole fleet + 11.8 tn deuterium
    // from the planet to the moon without asking. The automatic self-heal "fleet
    // on the wrong body" now only works when the operator consciously enables it
    // (the FERRY button in the Mining section); manual moves = RESCUE / Deploy.
    moonFerry: { enabled: false },
    asteroidMining: {
      enabled: false,
      minersPerMission: 0, // 0 = send all available. Used as fallback ONLY when
                           // right-sizing has no data yet (no cargo + no yield estimate).
      // ── v2.10.0: right-sizing + parallel dispatch ──
      // The game caps how much one mission collects at the asteroid miner
      // fleet's TOTAL cargo capacity, and an asteroid holds resources roughly
      // proportional to your hourly production (≈ constant within a day). So
      // sending 100% of miners every time wastes ships that just ride along
      // empty. Right-sizing sends only ceil(expectedResources / cargoPerMiner
      // × bufferFactor) miners, leaving the rest at home to fly PARALLEL
      // missions to the other asteroids the game spawns (3–6/h).
      parallelDispatch: true,       // keep mining with leftover miners instead of waiting for the full fleet to return
      maxConcurrentMiningFleets: 0, // hard cap on simultaneous mining fleets; 0 = limited only by the game's fleet slots
      // User model (v2.10.4): "miners per flight" + "total miners to use" →
      // the bot launches floor(total / perFlight) flights in parallel, then
      // waits for returns. e.g. total 100000, perFlight 50000 → 2 flights.
      // totalMinersToUse 0 = no budget cap (limited only by fleet slots).
      // minersPerMission (per flight) 0 = send ALL available in a single wave.
      totalMinersToUse: 0,          // budget of miners to commit across simultaneous flights; 0 = unlimited
      minMinersPerMission: 1,       // never send fewer than this (also the floor for "miners left home" to bother going parallel)
      // v2.22.0: a parallel flight must carry at least this fraction of the
      // intended per-flight size, or the leftover miners wait for a full one.
      // A mission's haul is capped by the fleet's total cargo, so half a fleet
      // doesn't collect half an asteroid — it collects half a cap and abandons
      // the rest. 0 = off (fly any remainder, pre-2.22 behaviour).
      partialFlightMinRatio: 0.5,
      cargoPerMiner: 0,             // cargo capacity of ONE asteroid miner; 0 = auto-learn from the fleet confirmation page
      expectedResourcesPerAsteroid: 0, // expected resources per asteroid; 0 = auto-learn from mission reports (set manually to seed before learning)
      bufferFactor: 1.15,           // over-provision factor vs the estimate (covers above-average asteroids)
      yieldSampleSize: 20,          // rolling window of "resources found" reports used for the estimate
      estimatePercentile: 85,       // size the fleet against this percentile of samples (not the mean) so big asteroids aren't under-served
      learnFromReports: true,       // parse asteroid mining reports to learn expectedResources (see AsteroidYieldTracker)
      scanIntervalMin: 15, // minutes between range re-scans when a sweep found nothing NEW. (v2.10.12: was 45 — OGameX refreshes asteroid hints far sooner, so a full set of fresh ranges sat ignored for up to 45min. The immediate-rescan-on-new-ranges path handles the common case; this is just the genuinely-nothing-new fallback.)
      maxFlightMinutes: 45, // safety cap on one-way flight time; ranges beyond this are skipped. Formula max(11, ceil(11+Δ/15)) hits 45min at Δ=499 (max same-galaxy distance), so 45 ensures every range the game reports gets scanned. Lower values silently drop far ranges and the bot keeps spinning on a few empty close ones.
      // Ship types to use for asteroid mining, tried in order.
      // OGameX requires ASTEROID_MINER — only this ship type is allowed for asteroid missions.
      minerShipTypes: ["ASTEROID_MINER"],
      // Base planet from which miners ALWAYS launch. Set to null to fall back
      // to min-over-all-planets behavior. Per-host storage means each universe
      // remembers its own base independently (set via UI or saved config).
      // v2.73.0: 05.08 ~22:30 the owner MOVED the base to [3:272:7]
      // (the attacker jumped into the old system, 3 min flight from the base; the new
      // system is full — nobody can squeeze in anymore).
      minerBase: { galaxy: 3, system: 272, position: 7 },
      // ── v2.84.0: fixed launch point for MINERS (null = active body) ──
      // Owner's decision 12.08: asteroids always spawn in g3 (that's where
      // most planets are), and expeditions fly from g2 — miners should live
      // on the configured moon in g3 and the bot switches to it by itself before
      // dispatching. The body (planet/moon) follows from the baseBody mode.
      launchFrom: null,   // { galaxy, system, position } | null
    },
    // ── v2.15.0: incoming-attack alarm ──
    // ── v2.57.0: Fleet Save (FS) ──
    // Safest FS: dispatch FROM THE MOON to another moon with a Station mission
    // and RECALL mid-flight. A recalled fleet takes as long to return as it flew, so
    //     return = start + 2 × recall delay
    // The owner gives the return time; the bot computes when to launch and when
    // to recall. Miners stay home — they're working.
    fleetSave: {
      enabled: false,
      from: { galaxy: 3, system: 272, position: 7 },  // v2.75.0: NO LONGER forces the launch point — FS flies from the currently active moon; it's only a fallback routeKey on pages without the planet bar
      to: null,                // target to RE-PICK after the move (old 3:269:5 is obsolete)
      returnAt: null,          // ISO, return hour set by the owner
      speedPercent: 10,        // slower = longer flight = longer possible FS
      excludeTypes: ["ASTEROID_MINER"],
    },
    threatAlarm: {
      enabled: true,
      // ── v2.21.0: act on the alarm, don't just shout about it ──
      // The old objection to arming this was that the mission bar can't tell an
      // attack from an espionage probe, so every probe would launch the whole
      // economy at the moon. That objection was half an argument: it priced the
      // false positive as permanent, when the fleet only has to sit out the
      // alert. With autoReturn the cost of a wrong guess is one alert window of
      // downtime (alert clears 10min after the last sighting) plus fuel for a
      // same-coords hop — against losing everything for being asleep. Cheap
      // insurance, so it defaults ON.
      autoSave: true,
      autoReturn: true,
      // v2.78.0: a second attack on ANOTHER colony while an alarm is running.
      // The toggle exists so you can get back to 2.77.2 behaviour
      // without swapping script versions — the first colony is rescued the same
      // way in both settings.
      rescueQueue: true,
      // ── v2.85.0: ESCAPE IN THE AIR ──
      // Attack on BOTH bodies of one pair at once (planet + moon, e.g. a DS
      // "destroy moon" + attack on the planet): evacuating within the pair
      // moves the fleet into the second strike. Instead EVERYTHING flies
      // a slow Deploy to another colony and RECALLS after the attacks pass
      // (a fleet in flight is untouchable). OFF = 2.84.0 behaviour.
      airSave: true,
      // v2.80.0: a quiet sound keeping the tab alive in the background.
      // Side effect: the tab gets a speaker icon and shows up
      // in media controls. Hence the toggle.
      keepAwake: true,
      // v2.74.0: this much deuterium STAYS on the body during rescue and FS. Without it
      // rescue/FS would take everything — and a fleet returning later (e.g.
      // from an expedition) would have no fuel for its own evacuation. The reserve is
      // pocket change next to trillions in the treasury; an attacker would loot at most that.
      deutReserve: 100_000_000_000,
    },
    // ── v2.14.0: expeditions in WAVES ──
    // Position 16 of the base system, combat fleet split into N waves sent a
    // couple of minutes apart. The spacing is a safety feature, not politeness:
    // one fleet returning at a time means a hunter camping the return can take
    // at most one wave, and there's a window to react.
    expeditions: {
      enabled: false,
      waves: 8,                 // split the fleet into this many flights
      holdingHours: 1,          // "Expedition duration" on the send page
      // Spacing between waves, randomised in this range. v2.15.1: owner
      // confirmed ~60s is enough separation in practice, so the whole fleet
      // goes out in ~8 minutes and mining gets the rest of the hour.
      waveGapMinSec: 60,
      waveGapMaxSec: 90,
      slotReserve: 2,           // fleet slots to leave free for mining/manual play
      // v2.37.0: 0 = Heavy Cargo splits like any other ship (fleet ÷ waves).
      // A value > 0 is a deliberate override with a fixed number per wave — it only makes sense
      // when HC is needed in parallel for farming.
      heavyCargoPerWave: 0,
      // Never send these on an expedition. Miners are the mining module's;
      // colony ships are one-shot and irreplaceable.
      // v2.46.0: Death Star does NOT fly on expeditions. A wave flies at the speed
      // of the slowest unit, and a DS is 26 minutes one way instead of a few
      // — a single one freezes the whole wave for almost an hour and eats an
      // expedition slot that the rest of the fleet is missing.
      // v2.59.0: RECYCLER also stays home (owner's decision 2026-08-03).
      // It contributes nothing on an expedition, and it's the only ship with which
      // DebrisCollector can collect debris after expeditions — sending it in waves
      // left the collector without its tool.
      // v2.69.2: AVATAR doesn't fly on expeditions (owner's decision 05.08) —
      // a unique unit (1 pc.), nothing to look for in space.
      excludeTypes: ["ASTEROID_MINER", "COLONY_SHIP", "DEATH_STAR", "RECYCLER", "AVATAR"],
      // v2.48.0: an expedition can run into aliens and leave a debris field at
      // position 16 of the base system. That's our own resources — we collect them with recyclers.
      collectDebris: true,
      // Base = where the combat fleet sits; target is position 16 of ITS system.
      // null → falls back to the asteroid-mining base.
      base: null,
      // v2.84.0: fixed launch point for EXPEDITIONS (null = active body —
      // waves launch from wherever you're standing). Configured = the bot switches to that
      // body before each wave; the target is pos. 16 of ITS system, so returns
      // always come back to where they launched from.
      launchFrom: null,   // { galaxy, system, position } | null
    },
    // ── v2.11.0: Inactive-player farming (event: reward per fleet sent) ──
    // Scans user-given system ranges, attacks (i)/(I) inactive planets
    // with Heavy Cargo (mission=8, direct fleet URL — same 3-step flow as
    // asteroids). v2.90.0: coexists with asteroidMining — mining has
    // priority, farming works in the windows when the miners are in flight.
    inactiveFarming: {
      enabled: false,
      hcPerFlight: 100,          // ships per attack (manual, like miners per flight)
      // v2.72.0: ship of choice (the "idle farming" event). LIGHT_CARGO and
      // BATTLESHIP are sometimes faster than HEAVY_CARGO (shorter flight = slot free sooner
      // = more attacks), and BATTLESHIP survives leftover defense on
      // an inactive's planet. Names confirmed live: they are exactly
      // the data-ship-type from the fleet form (the same dictionary as the expedition roster).
      shipType: "HEAVY_CARGO",   // LIGHT_CARGO | HEAVY_CARGO | BATTLESHIP
      ranges: "",                // e.g. "3:100-200, 3:250-300" — scanned system by system
      targetCooldownMin: 180,    // don't re-attack the same planet within this window
      // v2.81.0: a new lap = a clean slate. Without this, the cooldown counted
      // by the clock cut targets in the second pass: a full sweep of 499
      // systems takes ~2 h, so planets conquered in the first hour
      // were still under the 180-minute block and got skipped.
      // With ON, the pace is set by the sweep length (+15 min break),
      // not an arbitrary clock. With OFF, pre-2.81.0 behaviour.
      repeatEachSweep: true,
      slotReserve: 2,            // keep this many fleet slots free (manual play / mining)
      // ── v2.89.0: rank filter + target database ──
      // Owner's observation (14.08): the bot attacked EVERY inactive, and the loot
      // from players at the bottom of the rank (2000+) doesn't even pay back the flight time — empty
      // colonies ate fleet slots. A player's rank sits in the tooltip of the galaxy
      // row ("Ranking: 2.881"), so the full sweep builds a TARGET
      // database (coords + player + rank), and subsequent laps only visit
      // systems with targets within the rank limit — instead of a ~2 h full
      // scan, a lap over the database takes minutes and hits only the fat targets.
      maxTargetRank: 800,        // attack ONLY inactives with rank ≤ N; 0 = no filter.
                                 // Unknown rank (parser couldn't read it) = attack + loud log.
      dbRefreshHours: 12,        // every this many hours the full range scan refreshes the target database
      // ── v2.91.0: fixed launch point for attacks (like miners/expeditions) ──
      // Configured coords = every attack leaves from that pair (the moon in MOON
      // mode), so you can farm ANOTHER galaxy without moving the fleet.
      // Empty = v2.74.8 behaviour: launch from the currently active body.
      launchFrom: null,          // { galaxy, system, position } | null
      // ── v2.97.0: loot priority ──
      // The bot learns each target's average loot from the Plunder Journal
      // and attacks the fattest targets first. The threshold cuts off
      // known small fry: a target with AVERAGE loot < threshold is skipped
      // (an unknown target never is — exploration teaches the database). 0 = no threshold.
      minTargetProfit: 0,
      // ── v2.98.0: sequential mode (owner's toggle, 17.08) ──
      // The owner saw loot priority in action and wants a choice: ON = the old
      // pre-v2.89 behaviour — EVERY pass sweeps the whole range in
      // order (1→end) and attacks targets in the order encountered; it disables
      // target-database laps AND loot sorting. OFF (default) =
      // loot priority: laps over known systems + fattest targets first.
      // The rank filter, blacklist and loot threshold work in BOTH modes.
      sequentialSweep: false,
    },
    // ── v2.13.0: auto-claim the green "Online bonus" menu button ──
    // (antimatter + Academy points). Independent of mining/farming — runs
    // whenever the bot is enabled and the button shows up.
    onlineBonus: {
      enabled: true,
      minGapMin: 2,   // floor between two claims (the bonus reappears on its own schedule)
      retryMin: 15,   // wait after a click that did NOT make the button disappear
    },
    // ── v2.12.0: humanizer — behavioural anti-detection ──
    humanizer: {
      breaks: true,              // random "coffee breaks": full-bot pause
      breakEveryMin: 35,         // after 35-65 min of activity…
      breakEveryMax: 65,
      breakLenMin: 5,            // …pause everything for 5-15 min
      breakLenMax: 15,
      maxAttacksPerDay: 0,       // farming: hard daily cap (0 = unlimited)
      wanderChance: 7,           // % chance to detour via Overview between farm systems
    },
    antiDetection: {
      minDelaySeconds: 30,
      maxDelaySeconds: 120,
      sleepStartHour: 0, // night mode disabled (start === end = always active)
      sleepEndHour: 0,
      jitterEnabled: true, // random "do nothing" pauses
    },
  };

  function deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
      if (overrides[key] && typeof overrides[key] === "object" && !Array.isArray(overrides[key]) &&
          defaults[key] && typeof defaults[key] === "object") {
        result[key] = deepMerge(defaults[key], overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  function loadConfig() {
    try {
      const saved = GM_getValue("ogamex_bot_config", null);
      const merged = saved ? deepMerge(DEFAULT_CONFIG, JSON.parse(saved)) : { ...DEFAULT_CONFIG };
      // antiDetection is code-controlled — never override from saved config.
      // v2.12.0 exception: the SLEEP WINDOW is user-configurable (UI inputs),
      // so those two fields survive the reset.
      const savedSleepStart = merged.antiDetection?.sleepStartHour;
      const savedSleepEnd = merged.antiDetection?.sleepEndHour;
      merged.antiDetection = { ...DEFAULT_CONFIG.antiDetection };
      if (Number.isFinite(savedSleepStart)) merged.antiDetection.sleepStartHour = savedSleepStart;
      if (Number.isFinite(savedSleepEnd)) merged.antiDetection.sleepEndHour = savedSleepEnd;

      // v2.16.1: one-shot — give the account a night. Start === end means the
      // window is OFF, i.e. the bot runs 24/7 with no daily quiet period, and
      // that is a far louder signal to an admin than anything about fleet
      // arithmetic. Sets 23:00-05:00 LOCAL time ONCE; both fields
      // stay editable in the panel afterwards and this never runs again, so
      // turning it back off sticks.
      {
        const NIGHT_KEY = "ogamex_migration_night_v2161";
        if (GM_getValue(NIGHT_KEY, "0") !== "1") {
          GM_setValue(NIGHT_KEY, "1");
          if (merged.antiDetection.sleepStartHour === merged.antiDetection.sleepEndHour) {
            merged.antiDetection.sleepStartHour = 23;
            merged.antiDetection.sleepEndHour = 5;
            // MUST persist: the one-shot key stops this from running again, so
            // without a write the next page load would reload the saved 0/0
            // and the window would silently vanish.
            saveConfig(merged);
            setTimeout(() => log("Night window enabled: 23:00-05:00 your local time — a 24/7 bot with no quiet hours is the loudest pattern there is. Change or disable it in the panel (equal start/end = off).", "warn"), 1500);
          }
        }
      }
      // v2.9.2 forced expeditions.enabled=false here because the UI had been
      // removed and old saved state could keep a headless module running.
      // v2.14.0 gives expeditions a real module AND a real toggle, so the
      // override is gone. The shape changed completely though (fleetComposition
      // / maxConcurrent → waves / holdingHours / …), so a saved v2.9-era block
      // is dropped once: deepMerge would otherwise keep dead keys around and,
      // worse, resurrect enabled=true from a config the user never reviewed.
      if (merged.expeditions && ("fleetComposition" in merged.expeditions || "maxConcurrent" in merged.expeditions)) {
        merged.expeditions = { ...DEFAULT_CONFIG.expeditions };
      }

      // v2.9.3 migration: v2.9.0 default minerBase was 6:71:9 (old nexus
      // playthrough). Athena users got that saved in their host-scoped
      // storage on first toggle, then v2.9.1+ bumped the default to
      // 3:269:8 but deepMerge kept the stale saved value. Result: bot
      // sorted "closest-first" against the WRONG galaxy and dispatched
      // fleets that arrived after the asteroid TTL. One-shot reset.
      // v2.37.0: Heavy Cargo joins the normal split. Without the migration
      // the saved config (a fixed 50 000 000 per wave and HC on the
      // exclusion list) would keep the old behaviour despite the new default values.
      {
        const HC_KEY = "ogamex_migration_hc_split_v237";
        if (GM_getValue(HC_KEY, "0") !== "1") {
          GM_setValue(HC_KEY, "1");
          if (merged.expeditions) {
            merged.expeditions.heavyCargoPerWave = 0;
            merged.expeditions.excludeTypes = (merged.expeditions.excludeTypes || [])
              .filter(t => String(t).toUpperCase() !== "HEAVY_CARGO");
            saveConfig(merged);
            setTimeout(() => log("Heavy Cargo now splits into waves like any other ship (was: a fixed number per wave). You can change this with the Heavy Cargo / wave field — 0 = split.", "info"), 1500);
          }
        }
      }

      // v2.39.1: the old mining-flight counter ("all missions minus
      // expeditions") could stall the scan for 90 minutes ("flight budget
      // reached (28/3)"). After replacing the counter we also lift the pause that
      // this bug had managed to set — otherwise mining stands still until it expires.
      {
        const MF_KEY = "ogamex_migration_mining_flights_v2391";
        if (GM_getValue(MF_KEY, "0") !== "1") {
          GM_setValue(MF_KEY, "1");
          GM_setValue("ogamex_fleet_return_at", "0");
          setTimeout(() => log("The mining-flight counter now counts only the bot's OWN flights (manually sent missions no longer eat the limit). Scan pause lifted.", "info"), 1500);
        }
      }

      // v2.90.2: the RateLimiter pool (20 dispatches/h) is clogged with 76
      // farming attacks from before the fix — without a clear, mining would stay blocked
      // for up to an hour AFTER the version that fixes the bug is installed. One-shot.
      {
        const RL_KEY = "ogamex_migration_rate_pool_v2902";
        if (GM_getValue(RL_KEY, "0") !== "1") {
          GM_setValue(RL_KEY, "1");
          GM_setValue("ogamex_rate_actions", "[]");
          setTimeout(() => log("Dispatch pool/h cleared of farming entries (farming attacks no longer count toward the miners' pool) — asteroid scanner unblocked.", "info"), 1500);
        }
      }

      // v2.46.0: the config is stored on the player's side, so changing a default
      // alone wouldn't do anything — we have to add DS to his exclusion list.
      {
        const DS_KEY = "ogamex_migration_no_deathstar_v246";
        if (GM_getValue(DS_KEY, "0") !== "1") {
          GM_setValue(DS_KEY, "1");
          if (merged.expeditions) {
            const ex = (merged.expeditions.excludeTypes || []).map(t => String(t).toUpperCase());
            if (!ex.includes("DEATH_STAR")) {
              merged.expeditions.excludeTypes = [...ex, "DEATH_STAR"];
              saveConfig(merged);
              setTimeout(() => log("Death Star no longer flies on expeditions — a wave flies at the speed of the slowest unit, and a DS is 26 min one way.", "info"), 1500);
            }
          }
        }
      }

      // v2.59.0: the config is stored on the player's side, so changing a default
      // value alone won't help (same mechanism as the DS in 2.46.0) — we have
      // to add RECYCLER to his expedition exclusion list.
      {
        const RC_KEY = "ogamex_migration_no_recycler_expo_v259";
        if (GM_getValue(RC_KEY, "0") !== "1") {
          GM_setValue(RC_KEY, "1");
          if (merged.expeditions) {
            const ex = (merged.expeditions.excludeTypes || []).map(t => String(t).toUpperCase());
            if (!ex.includes("RECYCLER")) {
              merged.expeditions.excludeTypes = [...ex, "RECYCLER"];
              saveConfig(merged);
              setTimeout(() => log("Recyclers no longer fly on expeditions — they stay home to collect debris (DebrisCollector).", "info"), 1500);
            }
          }
        }
      }

      // v2.69.2: AVATAR added to expedition exclusions (owner's decision 05.08) —
      // same migration mechanism as DS/RECYCLER: the player's saved config
      // holds the old list; changing the default alone won't do anything.
      {
        const AV_KEY = "ogamex_migration_no_avatar_expo_v2692";
        if (GM_getValue(AV_KEY, "0") !== "1") {
          GM_setValue(AV_KEY, "1");
          if (merged.expeditions) {
            const ex = (merged.expeditions.excludeTypes || []).map(t => String(t).toUpperCase());
            if (!ex.includes("AVATAR")) {
              merged.expeditions.excludeTypes = [...ex, "AVATAR"];
              saveConfig(merged);
              setTimeout(() => log("AVATAR no longer flies on expeditions — it stays home.", "info"), 1500);
            }
          }
        }
      }

      // ── v2.73.0 migration: BASE MOVE [3:269:8] → [3:272:7] (05.08 ~22:30) ──
      // The owner moved the main planet and moon (the attacker jumped into
      // the old system, 3 min of flight away). The saved config would keep the old base —
      // and the ferry would Deploy the ENTIRE fleet every 2 h to the non-existent [3:269:8].
      // Reset the base + all learned knowledge about the old moon and old routes.
      {
        const MB_KEY = "ogamex_migration_base_3272_v273";
        if (GM_getValue(MB_KEY, "0") !== "1") {
          GM_setValue(MB_KEY, "1");
          merged.asteroidMining.minerBase = { galaxy: 3, system: 272, position: 7 };
          if (merged.fleetSave) {
            merged.fleetSave.from = { galaxy: 3, system: 272, position: 7 };
            merged.fleetSave.to = null; // old target 3:269:5 obsolete — pick a new one
          }
          saveConfig(merged);
          // Knowledge of the OLD moon: rescue-target link, galaxy-row learning flags
          // — everything is re-learned from the [3:272:7] row.
          GM_setValue("ogamex_moon_link", "null");
          GM_setValue("ogamex_moon_fetch_dead", "");
          GM_setValue("ogamex_moon_fetch_tries", "0");
          GM_setValue("ogamex_moon_visit_at", "0");
          GM_setValue("ogamex_moon_markup_dumped_v2253", "");
          // Queues built on the old base (distances measured from 3:269).
          GM_setValue("ogamex_scan_state", null);
          GM_setValue("ogamex_farm_scan", "null");
          GM_setValue("ogamex_fs_flight_ms", "{}");
          // Ferry: first trip from the NEW base right away (consolidation on the new moon).
          GM_setValue("ogamex_ferry_at", "0");
          console.log("[OGameX v2.73.0] migration: base moved to [3:272:7], knowledge of the old moon cleared");
          setTimeout(() => log("MOVE: bot base set to [3:272:7] (planet+moon). The rescue target will be learned from the new galaxy row; Fleet Save target needs to be re-picked.", "success"), 1500);
        }

        // ── v2.74.6 migration: deuterium reserve 1 bn → 100 bn (owner's decision 06.08) ──
        // 1 bn is too little fuel for fleets landing on the planet; the saved
        // config holds the old value, so we bump it once to the new
        // default of 100 bn (unless the owner already set a HIGHER one).
        const DR_KEY = "ogamex_migration_deut_reserve_v2746";
        if (GM_getValue(DR_KEY, "0") !== "1") {
          GM_setValue(DR_KEY, "1");
          if (merged.threatAlarm && (parseInt(merged.threatAlarm.deutReserve) || 0) < 100_000_000_000) {
            merged.threatAlarm.deutReserve = 100_000_000_000;
            saveConfig(merged);
            setTimeout(() => log("Deuterium reserve on the planet raised to 100 bn (rescue/FS/ferry leave this much in the tank).", "info"), 1500);
          }
        }
      }

      const MIGRATION_KEY = "ogamex_migration_v293_done";
      if (GM_getValue(MIGRATION_KEY, "0") !== "1") {
        merged.asteroidMining.minerBase = { ...DEFAULT_CONFIG.asteroidMining.minerBase };
        // Stale scan queue was built against the wrong base — drop it so
        // the next scan rebuilds with the correct base.
        GM_setValue("ogamex_scan_state", null);
        GM_setValue(MIGRATION_KEY, "1");
        saveConfig(merged);
        console.log("[OGameX v2.9.3] migration: minerBase reset to", merged.asteroidMining.minerBase, "scan state cleared");
      }

      // v2.9.7 migration: prior to v2.9.6, TTL-skips were adding systems
      // to the 1h DispatchedAsteroids cooldown despite no fleet ever
      // being sent. Result: respawned asteroids in those slots were
      // skipped for the next hour with "already dispatched" log. v2.9.6
      // fixed the code, but users still have a corrupted set from the
      // old behavior. One-shot clear so the bot can pick up live
      // asteroids in previously-poisoned coords immediately.
      const MIGRATION_V297 = "ogamex_migration_v297_done";
      if (GM_getValue(MIGRATION_V297, "0") !== "1") {
        GM_setValue("ogamex_dispatched_asteroids", "[]");
        GM_setValue(MIGRATION_V297, "1");
        console.log("[OGameX v2.9.7] migration: DispatchedAsteroids cleared (stale TTL-skip entries from pre-v2.9.6)");
      }

      // v2.9.9 migration: older saved configs had maxFlightMinutes as low as
      // 20, which silently filtered out almost every range the game returned
      // (same-galaxy distances of 130+ → flight ≥20min). Bot would queue 4
      // empty systems near the cap, find nothing, sleep 45min, repeat forever
      // with full miner fleets parked. Force-bump any saved value below the
      // new default so existing users actually scan full ranges. Also clear
      // the stale scan queue + cooldown so the next tick rebuilds against
      // the new filter immediately instead of waiting out the old cooldown.
      const MIGRATION_V299 = "ogamex_migration_v299_done";
      if (GM_getValue(MIGRATION_V299, "0") !== "1") {
        const defaultMaxFlight = DEFAULT_CONFIG.asteroidMining.maxFlightMinutes;
        if (merged.asteroidMining.maxFlightMinutes < defaultMaxFlight) {
          const old = merged.asteroidMining.maxFlightMinutes;
          merged.asteroidMining.maxFlightMinutes = defaultMaxFlight;
          saveConfig(merged);
          console.log(`[OGameX v2.9.9] migration: maxFlightMinutes ${old} → ${defaultMaxFlight}min (was filtering most ranges)`);
        }
        GM_setValue("ogamex_scan_state", null);
        GM_setValue("ogamex_scan_cooldown_until", "0");
        GM_setValue(MIGRATION_V299, "1");
        console.log("[OGameX v2.9.9] migration: scan state + cooldown cleared — next tick scans fresh");
      }
      // v2.10.15 migration: the no-asteroid cooldown is now SHORT whenever the
      // game still shows hint ranges (asteroids respawn in them). Clear any
      // stale long cooldown left by older versions so the new behavior takes
      // effect on this load instead of after the old 45min finishes ticking.
      const MIGRATION_V21015 = "ogamex_migration_v21015_done";
      if (GM_getValue(MIGRATION_V21015, "0") !== "1") {
        GM_setValue("ogamex_scan_cooldown_until", "0");
        GM_setValue(MIGRATION_V21015, "1");
        console.log("[OGameX v2.10.15] migration: stale scan cooldown cleared");
      }

      return merged;
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  function saveConfig(config) {
    GM_setValue("ogamex_bot_config", JSON.stringify(config));
  }

  let CONFIG = loadConfig();

  // v2.10.15: how often to re-sweep hint ranges that are STILL live. OGameX
  // keeps showing the same ranges for a long time and asteroids respawn inside
  // them at position 17 over time, so a long idle cooldown there makes the bot
  // miss them (user had to keep clicking "Scan Asteroids" by hand). Hardcoded
  // on purpose — it bypasses the persisted scanIntervalMin, which is often a
  // stale 45 baked into old saved configs that deepMerge keeps overriding the
  // code default with. The long scanIntervalMin now only applies when there are
  // no hint ranges at all.
  const ACTIVE_RANGE_RECHECK_MIN = 10;

  // v2.27.0: how often to peek at the hint pool WHILE a scan cooldown runs.
  // Asteroids are the owner's largest income by far, so sitting out a 10-minute
  // cooldown after hints reappear is the single most expensive thing this bot
  // can do. One ajax call per probe (a deep fetch is six), so this is cheap.
  const HINT_PROBE_EVERY_MS = 2 * 60 * 1000;

  // ═══════════════════════════════════════════════════════════════
  //  LOGGING
  // ═══════════════════════════════════════════════════════════════

  const MAX_LOG_ENTRIES = 300;
  const LOG_STORAGE_KEY = "ogamex_bot_logs";

  // Load persisted logs from previous page navigations
  let logEntries = (() => {
    try {
      const raw = GM_getValue(LOG_STORAGE_KEY, "[]");
      return JSON.parse(raw).slice(0, MAX_LOG_ENTRIES);
    } catch { return []; }
  })();

  function log(msg, type = "info") {
    const time = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    // v2.93.0: DOM debug dumps can be ~10 KB per line, and the journal
    // (300 entries) is serialized to storage on EVERY entry -
    // megabyte JSONs were grinding the CPU all day. 600 characters covered
    // every diagnosis from recent weeks; the full text is visible live anyway.
    const msgStr = String(msg);
    const entry = { time, msg: msgStr.length > 600 ? msgStr.slice(0, 600) + " [truncated]" : msgStr, type };
    logEntries.unshift(entry);
    if (logEntries.length > MAX_LOG_ENTRIES) logEntries.pop();
    // Persist logs across page navigations
    // v2.94.0: debounced writes (1/s) instead of serializing 300 entries on
    // EVERY line; a flush on pagehide catches entries from right before the navigation.
    schedulePersistLogs();
    updateLogUI();
  }

  // ═══════════════════════════════════════════════════════════════
  //  DEFENSE JOURNAL  (v2.31.0)
  // ═══════════════════════════════════════════════════════════════
  // A separate, persistent record of DEFENSE events ONLY. The regular log drowns
  // in asteroid scans and expedition waves — several hundred lines an hour —
  // so if an attack got through, the evidence would be unrecoverable exactly
  // when it's needed most. Here goes what answers
  // the question "why did the fleet die": what the bot saw in the mission bar, when
  // it was blind, what it sent where, and what failed.
  //
  // Capacity counted in DAYS, not lines: reads with no foreign fleets
  // come in once every 10 minutes, so 600 entries is over four days of quiet —
  // and much more history when something happens, because then what counts
  // is the minutes around the event, not weeks.
  // ═══════════════════════════════════════════════════════════════
  //  NOTIFIER (v2.67.0) — push to the phone via ntfy.sh
  // ═══════════════════════════════════════════════════════════════
  // A second line of defense in case the automatic fleet-lifting
  // fails (a dead browser won't send it, but everything the bot
  // MANAGED to detect also reaches the phone). ntfy.sh: free, no account —
  // a randomly-named topic works like a secret, and the phone app
  // subscribes to it by name.
  //
  // What goes to the phone (via a hook in ThreatLog.add — the journal already knows what
  // matters): ATTACK (urgent), RESCUE sent, defense ERROR (high),
  // FS failure (high), RETURN (quiet). Routine reads — never.
  const Notifier = {
    KEY_TOPIC: "ogamex_ntfy_topic",
    KEY_ON: "ogamex_ntfy_on",
    KEY_VOICE: "ogamex_voice_on",   // v2.72.1: voice alarm on the laptop
    KEY_LAST: "ogamex_ntfy_last",   // { "<kind>": ts } — per-kind throttle
    THROTTLE_MS: { "ATTACK": 5 * 60 * 1000, "RESCUE": 2 * 60 * 1000, "RETURN": 5 * 60 * 1000, "ERROR": 5 * 60 * 1000, "FS": 5 * 60 * 1000 },

    topic() {
      let t = GM_getValue(this.KEY_TOPIC, "");
      if (!t) {
        // 12 random characters = an unguessable topic; the prefix says what it is.
        t = "ogamex-mch-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
        GM_setValue(this.KEY_TOPIC, t);
      }
      return t;
    },
    enabled() { return GM_getValue(this.KEY_ON, "1") === "1"; },

    _throttled(kind) {
      let last = {};
      try { last = JSON.parse(GM_getValue(this.KEY_LAST, "{}")); } catch {}
      const win = this.THROTTLE_MS[kind] || 5 * 60 * 1000;
      if (Date.now() - (last[kind] || 0) < win) return true;
      last[kind] = Date.now();
      GM_setValue(this.KEY_LAST, JSON.stringify(last));
      return false;
    },

    push(title, msg, priority = "default", tags = "") {
      if (!this.enabled()) return;
      try {
        GM_xmlhttpRequest({
          method: "POST",
          url: "https://ntfy.sh/" + this.topic(),
          headers: { Title: title, Priority: priority, Tags: tags },
          data: String(msg).slice(0, 600),
          timeout: 15000,
          onload: () => {},
          onerror: () => log("[PUSH] ntfy.sh did not respond — the notification didn't go out.", "warn"),
          ontimeout: () => log("[PUSH] ntfy.sh timeout — the notification didn't go out.", "warn"),
        });
      } catch (e) { log(`[PUSH] error: ${e.message}`, "warn"); }
    },

    // ── v2.72.1: VOICE alarm on the laptop (Web Speech API) ──
    // Phone push can be inaudible (iOS: silent mode/Sleep wins even
    // over priority=urgent — lesson 04.08). A laptop with the game tab open can
    // simply SAY that there's an attack — system synthesizer, zero
    // dependencies. Polish voice if the system has one; otherwise the default from lang.
    voiceEnabled() { return GM_getValue(this.KEY_VOICE, "1") === "1"; },
    speak(text, times = 3) {
      if (!this.voiceEnabled()) return;
      try {
        if (!("speechSynthesis" in window)) { log("[VOICE] the browser has no speechSynthesis.", "warn"); return; }
        const voice = (speechSynthesis.getVoices() || []).find(v => /^en/i.test(v.lang || "")) || null;
        for (let i = 0; i < Math.max(1, times); i++) {
          const u = new SpeechSynthesisUtterance(text);
          if (voice) u.voice = voice;
          u.lang = "en-US";
          u.rate = 1.0;
          u.volume = 1.0;
          speechSynthesis.speak(u); // the synthesizer queue paces the repeats by itself
        }
      } catch (e) { log(`[VOICE] synthesis error: ${e.message}`, "warn"); }
    },

    // ── v2.72.2: SIREN — 10-second alarm tune (Web Audio) ──
    // Plays UNDER the voice (quieter), so together it sounds like a real alarm.
    // Synthesized on the spot (triangle + envelope) — zero files, zero
    // network. Honesty: page navigation (and rescue navigates right away) cuts
    // the sound — it's a "wake up" signal, not a guaranteed 10-second concert.
    siren(seconds = 10) {
      if (!this.voiceEnabled()) return;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = this._audioCtx || (this._audioCtx = new Ctx());
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const master = ctx.createGain();
        master.gain.value = 0.35;
        master.connect(ctx.destination);
        const notes = [660, 880, 1046, 880]; // rising alarm motif
        const step = 0.45;
        const t0 = ctx.currentTime;
        for (let t = 0; t < seconds; t += step) {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = "triangle";
          o.frequency.value = notes[Math.round(t / step) % notes.length];
          g.gain.setValueAtTime(0, t0 + t);
          g.gain.linearRampToValueAtTime(1, t0 + t + 0.02);
          g.gain.setValueAtTime(1, t0 + t + step - 0.06);
          g.gain.linearRampToValueAtTime(0, t0 + t + step - 0.01);
          o.connect(g); g.connect(master);
          o.start(t0 + t);
          o.stop(t0 + Math.min(t + step, seconds));
        }
      } catch (e) { log(`[SIREN] error: ${e.message}`, "warn"); }
    },

    // Hook from the defense journal: the entry kind decides whether and how loudly.
    fromJournal(kind, msg) {
      const m = String(msg || "");
      if (kind === "ATTACK") {
        if (this._throttled("ATTACK")) return;
        this.push("⚔️ ATTACK on your OGameX account!", m, "urgent", "rotating_light");
        this.siren(10);
        this.speak("Attention! Attack on the base! Attention! Attack on the base!", 3);
      } else if (kind === "RESCUE" && /WYS[ŁL]ANE/i.test(m)) {
        if (this._throttled("RESCUE")) return;
        this.push("🛟 Fleet evacuated", m, "default", "shield");
      } else if (kind === "ERROR") {
        if (this._throttled("ERROR")) return;
        this.push("⚠️ Defense reports an ERROR — check the game!", m, "high", "warning");
        this.speak("Attention! Defense error! Check the game!", 1);
      } else if (kind === "FS" && /NIEUDANE|zosta/i.test(m)) {
        if (this._throttled("FS")) return;
        this.push("🌙 Fleet Save: problem", m, "high", "warning");
      } else if (kind === "RETURN" && /WYS[ŁL]ANE/i.test(m)) {
        if (this._throttled("RETURN")) return;
        this.push("✅ Fleet returned to base", m, "min", "white_check_mark");
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  WAKE LOCK (v2.68.0) — bot ON = the computer doesn't sleep
  // ═══════════════════════════════════════════════════════════════
  // Defense only works while the tab lives — and a sleeping laptop kills it.
  // The Screen Wake Lock API keeps the screen on, so the system doesn't go into
  // to sleep from idleness; works the same on macOS and Windows, without
  // caffeinate and without poking at power settings (important at work,
  // where there are no admin rights). Honest limitations: the game tab must
  // be VISIBLE (hidden/minimized = the system takes the lock back;
  // we regain it when the tab returns), and closing the lid puts it to sleep anyway.
  // ── v2.80.0: SECOND HALF OF "don't sleep" ──
  // WakeLock keeps the screen on, but ONLY while the tab is visible — the browser
  // takes the lock back on every hide (in the log: "The requesting document is
  // hidden"). We saw the effect 07.08 at 12:11-12:23: twelve minutes of silence,
  // the scheduled threat check was lost, and an attack in that window would have been detected
  // only after a session reload.
  //
  // The second half of the problem — freezing and throttling of timers in a background tab —
  // can be solved differently: a tab that PLAYS AUDIO is exempt
  // from intensive throttling and from freezing. So we play silence in a loop. The signal
  // is non-zero (amplitude 1/32768 ≈ -90 dBFS), because perfect silence is sometimes
  // counted as no sound — and it is absolutely inaudible.
  //
  // What it will NOT do, and you should know this: it will NOT stop the system from sleeping
  // or closing the lid. A web page has no permission to do that —
  // that is set in Windows power settings. This module rescues the "tab
  // in background / another window on top" case, not the "laptop went to sleep" case.
  const AudioKeepalive = {
    _el: null,
    _playing: false,
    _wired: false,
    _starting: false,

    // v2.80.1: log at most once per 30 min PER MESSAGE KIND.
    // The bot reloads the page every dozen or so seconds, and each new document
    // starts from scratch — without this, a single sound message ate the whole log
    // (exactly the same lesson as with the self-test in v2.77.2: a repeated
    // message stops being information and becomes noise).
    _say(kind, msg, level) {
      try {
        const KEY = `ogamex_wake_said_${kind}`;
        const last = parseInt(GM_getValue(KEY, "0")) || 0;
        if (Date.now() - last < 30 * 60 * 1000) return;
        GM_setValue(KEY, String(Date.now()));
      } catch {}
      log(msg, level);
    },

    _url() {
      const rate = 8000, n = rate;            // 1 s mono 16-bit
      const buf = new ArrayBuffer(44 + n * 2);
      const dv = new DataView(buf);
      const wr = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
      wr(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); wr(8, "WAVE");
      wr(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      wr(36, "data"); dv.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
      return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    },

    // Called at startup and from every defense tick — it repairs itself when
    // navigation kills the element or the owner flips the toggle.
    ensure() {
      if (!CONFIG.threatAlarm?.keepAwake) { this.stop(); return; }
      // v2.80.1: play() is asynchronous. ensure() is called both by the script start
      // and the defense tick — without this guard the second call started play()
      // on an element that was just starting, and the browser rejected it
      // due to the autoplay policy. Symptom in the log 07.08 13:07-13:28:
      // "tab kept alive" and "waiting for a click" in the same
      // second, over and over. A race, not a lack of consent.
      if (this._starting) return;
      if (this._playing && this._el && !this._el.paused) return;
      this.start();
    },

    start() {
      try {
        if (!this._el) {
          this._el = new Audio(this._url());
          this._el.loop = true;
          this._el.volume = 1;
        }
        this._starting = true;
        this._el.play().then(() => {
          this._starting = false;
          if (this._playing) return;
          this._playing = true;
          this._say("ok", "[WAKE] tab kept alive with a silent sound — in the background it won't be frozen or throttled.", "info");
        }).catch((e) => {
          this._starting = false;
          // Autoplay policy: the first time requires a user gesture.
          // We don't fight it — we wait for any click in the game.
          if (this._wired) return;
          this._wired = true;
          this._say("wait", `[WAKE] keep-alive sound is waiting for the first click in the game (${e.name}) — click anywhere on the page.`, "warn");
          const kick = () => {
            document.removeEventListener("click", kick, true);
            document.removeEventListener("keydown", kick, true);
            this._wired = false;
            this.start();
          };
          document.addEventListener("click", kick, true);
          document.addEventListener("keydown", kick, true);
        });
      } catch (e) {
        log(`[WAKE] keep-alive sound unavailable: ${e.message}`, "warn");
      }
    },

    stop() {
      if (!this._el) return;
      try { this._el.pause(); } catch {}
      this._playing = false;
    },
  };

  const WakeLock = {
    _lock: null,
    _wired: false,
    supported() { return !!navigator.wakeLock?.request; },
    async acquire() {
      if (!CONFIG.enabled || !this.supported()) return;
      if (this._lock && !this._lock.released) return;
      try {
        this._lock = await navigator.wakeLock.request("screen");
        log("[WAKE] sleep lock active — the computer won't sleep while the game tab is visible.", "info");
      } catch (e) {
        log(`[WAKE] failed to block sleep: ${e.message}`, "warn");
      }
    },
    release() {
      if (!this._lock) return;
      try { this._lock.release(); } catch {}
      this._lock = null;
      log("[WAKE] sleep lock released (bot OFF) — the computer can sleep normally.", "info");
    },
    wire() {
      if (this._wired) return;
      this._wired = true;
      if (!this.supported()) {
        log("[WAKE] browser doesn't support the Wake Lock API — handle sleep at the system level (caffeinate).", "warn");
        return;
      }
      // The browser releases the lock on every tab hide — the only
      // legal moment to regain it is when visibility returns.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.acquire();
      });
      this.acquire();
    },
  };

  const ThreatLog = {
    KEY: "ogamex_threat_journal",
    MAX: 600,
    // ── v2.47.0: the night must be visible in the morning ──
    // The journal kept the 600 most recent entries regardless of kind. Routine
    // bar readings pile up on EVERY change in mission count, and the bot sends
    // a wave every ~70 s — so six hundred slots can fill with routine alone
    // in a few hours and push out the only entries this journal
    // was created for: alert, rescue and return. After the night there would be a record of "12 missions /
    // 12 own" ×600.
    //
    // Now two shelves: important events live 12 hours (and that's enough to
    // know after a night's sleep what happened), and routine readings have
    // their own small limit and cannot push out anything important.
    RETAIN_MS: 12 * 60 * 60 * 1000,
    ROUTINE_MAX: 60,
    IMPORTANT: ["ATTACK", "RESCUE", "RETURN", "ERROR", "end"],

    isImportant(kind) { return this.IMPORTANT.includes(kind); },

    _cache: null,
    _cacheAt: 0,
    all() {
      // v2.94.0: 30 s cache - the status bar computes summary() every 5 s, and every
      // call parsed up to 600 entries x 400 chars. add() clears the cache.
      if (this._cache && Date.now() - this._cacheAt < 30 * 1000) return this._cache;
      try { this._cache = JSON.parse(GM_getValue(this.KEY, "[]")) || []; } catch { this._cache = []; }
      this._cacheAt = Date.now();
      return this._cache;
    },

    add(kind, msg) {
      const now = new Date();
      const stamp = `${now.toLocaleDateString("en-GB")} ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      const list = this.all();
      list.unshift({ t: stamp, at: Date.now(), k: kind, m: String(msg).slice(0, 400) });
      GM_setValue(this.KEY, JSON.stringify(this._prune(list)));
      this._cache = null; // v2.94.0: the next read sees the fresh entry
      try { Notifier.fromJournal(kind, msg); } catch {}  // v2.67.0: push to phone
      try { updateStatusUI(); } catch {}
    },

    // v2.66.4: entries before 2.47.0 have no `at` and were treated as forever
    // fresh — an alert from August 2 was still haunting the "12h" header on August 4.
    // We reconstruct the timestamp from the text field `t` ("2.08.2026 12:18:09"); when
    // that fails, the entry gets zero age and falls out of retention.
    _stampOf(e) {
      if (Number.isFinite(e.at)) return e.at;
      const m = String(e.t || "").match(/(\d{1,2})\.(\d{2})\.(\d{4})\D+(\d{2}):(\d{2}):(\d{2})/);
      if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]).getTime();
      return 0;
    },
    _prune(list) {
      const cutoff = Date.now() - this.RETAIN_MS;
      const important = [];
      const routine = [];
      for (const e of list) {
        const at = this._stampOf(e);
        if (this.isImportant(e.k)) { if (at >= cutoff) important.push(e); }
        else if (routine.length < this.ROUTINE_MAX) routine.push(e);
      }
      const out = [...important, ...routine].sort((a, b) => (b.at || 0) - (a.at || 0));
      return out.slice(0, this.MAX);
    },

    clear() { GM_setValue(this.KEY, "[]"); },

    // What happened in the last N hours — one sentence for the panel and the log.
    summary(hours = 12) {
      const cutoff = Date.now() - hours * 60 * 60 * 1000;
      const recent = this.all().filter(e => this._stampOf(e) >= cutoff);
      const count = (k) => recent.filter(e => e.k === k).length;
      const lastOf = (k) => recent.find(e => e.k === k)?.t || null;
      // ── v2.70.2: alerts counted as EPISODES, not entries ──
      // A single attack generates a dozen or so ATTACK entries (detections, changes
      // in fleet counts, HTML dumps, target…) — the bar showed "31 alerts" for
      // two real episodes (owner report 05.08 15:53).
      // Episode = alert lifted ("end") + possibly one currently ongoing.
      let alarms = count("end");
      try { if (ThreatMonitor.active()) alarms += 1; } catch {}
      const saves = recent.filter(e => e.k === "RESCUE" && /WYS[ŁL]ANE/i.test(e.m)).length;
      const returns = recent.filter(e => e.k === "RETURN" && /WYS[ŁL]ANE/i.test(e.m)).length;
      const errors = count("ERROR");
      return {
        hours, alarms, saves, returns, errors,
        lastAlarm: lastOf("ATTACK"),
        lastSave: recent.find(e => e.k === "RESCUE" && /WYS[ŁL]ANE/i.test(e.m))?.t || null,
        lastReturn: recent.find(e => e.k === "RETURN" && /WYS[ŁL]ANE/i.test(e.m))?.t || null,
        text: alarms || saves || returns || errors
          ? `${hours} h: ${alarms} alarm(s)`
            + (saves ? `, ${saves}× fleet to the moon (last ${lastOf("RESCUE")})` : "")
            + (returns ? `, ${returns}× return` : "")
            + (errors ? `, ${errors} error(s)` : "")
          : `${hours} h: quiet — not a single foreign fleet.`,
      };
    },

    asText() {
      const list = this.all();
      if (!list.length) return "(defense journal empty)";
      const s = this.summary(12);
      const head = `SUMMARY ${s.text}`
        + (s.lastAlarm ? `\nLast alert: ${s.lastAlarm}` : "")
        + (s.lastSave ? `\nLast rescue (fleet to the other body): ${s.lastSave}` : "")
        + (s.lastReturn ? `\nLast return: ${s.lastReturn}` : "");
      return `${head}\n${"-".repeat(60)}\n` + list.map(e => `${e.t}  [${e.k}]  ${e.m}`).join("\n");
    },

    lastAlarmAt() {
      const hit = this.all().find(e => e.k === "ATTACK");
      return hit ? hit.t : null;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  ERROR-PAGE RECOVERY  (v2.10.11)
  //  OGameX occasionally serves its OWN "Error occurred / Page not
  //  found" page (URL like /Error/NotFound?aspxerrorpath=/overview).
  //  On it NONE of the game UI exists, so the bot would just sit idle
  //  until the 25-min watchdog reload — long enough for in-flight
  //  miners to be spotted and scrapped. Detect it on load and go
  //  straight back into the game ("< Back to game"), with a backoff so
  //  a sustained outage can't turn into a tight reload loop.
  // ═══════════════════════════════════════════════════════════════
  function isOGameXErrorPage() {
    // URL signal: /Error/..., /Error/NotFound, or an ?aspxerrorpath= query.
    if (/\/Error(\/|$)|NotFound|aspxerrorpath/i.test(window.location.pathname + window.location.search)) return true;
    // Content signal (in case the URL ever differs): the modal shows both lines.
    const t = document.body ? document.body.textContent : "";
    return /Error occurred/i.test(t) && /Page not found/i.test(t);
  }

  function findBackToGameButton() {
    const els = document.querySelectorAll("a, button, input[type=button], input[type=submit]");
    for (const el of els) {
      const txt = (el.textContent || el.value || "").trim();
      if (/back to game/i.test(txt)) return el; // never matches "Back to lobby"
    }
    return null;
  }

  // v2.10.21: on the OGameX landing/lobby page (/ or /home) the user is still
  // LOGGED IN — they just click a "Play / Enter game" button to re-enter (no
  // password). Find that button so the bot can do the same instead of uselessly
  // reloading the landing page. Conservative text match; never a logout/register.
  function findGameEntryElement() {
    const els = document.querySelectorAll("a, button, input[type=button], input[type=submit]");
    const POS = /\b(play|graj|zagraj|enter\s*game|enter|wejd[zź]|wej[sś][cć]ie|do\s*gry|continue|kontynuuj|launch)\b/i;
    const NEG = /log\s*out|wyloguj|logout|register|rejestr|sign\s*up|reset|forgot|password|has[lł]o|news|forum|wiki|discord/i;
    for (const el of els) {
      const txt = (el.textContent || el.value || "").trim();
      const href = (el.getAttribute && el.getAttribute("href")) || "";
      if (!txt && !href) continue;
      if (NEG.test(txt) || NEG.test(href)) continue;
      if (POS.test(txt)) return el;
    }
    return null;
  }

  // v2.10.22: are we INSIDE the logged-in game (vs the logged-out login/landing
  // page)? OGameX's Overview tab lives at "/" or "/home" — the same paths the
  // bot used to treat as "login → bail", so on Overview it never built its panel
  // or started the scheduler (it only ran on /fleet, /galaxy, …). Detect in-game
  // chrome (top resource bar + section menu); if present we're logged in and
  // must run normally even on / or /home.
  function isLoggedInGamePage() {
    if (document.querySelector(".resource-item-metal, .resource-item-deuterium, #planetList, .smallplanet")) return true;
    for (const a of document.querySelectorAll("a.text-item")) {
      if (/^(galaxy|fleet|overview|resources|shipyard|research|defense)$/i.test((a.textContent || "").trim())) return true;
    }
    return false;
  }

  // Dump every clickable on the current page to the persisted log (survives the
  // page bail) — lets us see the exact landing-page buttons to target.
  function logClickables(tag) {
    const els = [...document.querySelectorAll("a, button, input[type=button], input[type=submit]")].slice(0, 60);
    const desc = els.map(el => {
      const t = (el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 30);
      const cls = el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "";
      const href = (el.getAttribute && el.getAttribute("href")) || "-";
      return `"${t}"[${el.tagName}${cls} href=${href}]`;
    });
    log(`[${tag}] ${els.length} clickables: ${desc.join(", ")}`, "warn");
  }

  // Returns true if we ARE on the error page and recovery was scheduled —
  // caller must then stop init() (we're navigating away).
  function handleErrorPageIfPresent() {
    if (!isOGameXErrorPage()) {
      // On a real game page → reset the consecutive-error streak.
      GM_setValue("ogamex_error_recover_streak", "0");
      // v2.61.0: end of an error-page episode → count and record how long the bot
      // was blind. Without this entry the blindness window was invisible in the journal —
      // the owner found it by accident, staring at a frozen screen.
      const epStart = parseInt(GM_getValue("ogamex_error_episode_at", "0")) || 0;
      if (epStart) {
        GM_setValue("ogamex_error_episode_at", "0");
        const min = Math.round((Date.now() - epStart) / 60000);
        log(`Back in the game after ${min} min of the OGameX error page.`, min >= 3 ? "warn" : "info");
        ThreatLog.add("end", `Back in the game after ${min} min of the error page — the defense can see again.`);
      }
      return false;
    }

    // v2.61.0: start of an episode → a trace in the defense journal (once per episode).
    if (!(parseInt(GM_getValue("ogamex_error_episode_at", "0")) || 0)) {
      GM_setValue("ogamex_error_episode_at", String(Date.now()));
      ThreatLog.add("ERROR", "OGameX is serving an error page — the bot is blind until it gets back into the game. Recovery started.");
    }

    // ── backoff: count recoveries that happen <90s apart as a "streak" ──
    const now = Date.now();
    const lastAt = parseInt(GM_getValue("ogamex_error_recover_at", "0"));
    let streak = parseInt(GM_getValue("ogamex_error_recover_streak", "0"));
    streak = lastAt && now - lastAt < 90 * 1000 ? streak + 1 : 0;
    GM_setValue("ogamex_error_recover_at", String(now));
    GM_setValue("ogamex_error_recover_streak", String(streak));

    // ── pick a recovery target ──
    // First try to re-request the exact page OGameX failed on (aspxerrorpath).
    // After a couple of fast repeats on that path, give up on it and use the
    // page's generic "Back to game" instead (→ overview).
    let specificTarget = null;
    const m = window.location.search.match(/[?&]aspxerrorpath=([^&#]+)/i);
    if (m && streak < 2) {
      try {
        const p = decodeURIComponent(m[1]);
        // accept only same-origin relative game paths; never bounce back to
        // an Error/ page or to login (/home).
        // v2.63.0: /overview is out too — IT DOES NOT EXIST ON THIS SERVER (404 every
        // time; it was behind all the error pages with
        // aspxerrorpath=/overview). The game overview lives under "/".
        if (/^\/[A-Za-z0-9]/.test(p) && !/^\/(Error|home|overview)\b/i.test(p)) specificTarget = p;
      } catch {}
    }

    // 0/1 → quick (~2-4s). Then exponential-ish, capped at 60s, so a sustained
    // OGameX outage backs off instead of hammering the server in a loop.
    const base = 2000 + Math.random() * 2000;
    const backoff = streak <= 1 ? base : Math.min(60000, base + Math.pow(2, streak) * 1000);

    log(`OGameX error page detected → recovering ${specificTarget ? "to " + specificTarget : "via < Back to game"} in ${Math.round(backoff / 1000)}s (streak ${streak}).`, "warn");

    setTimeout(() => {
      if (!isOGameXErrorPage()) return; // page changed under us — nothing to do
      if (specificTarget) {
        window.location.replace(specificTarget);
        return;
      }
      // Click the page's own "Back to game" — what a human would do.
      const btn = findBackToGameButton();
      if (btn) {
        log("Clicking < Back to game.", "info");
        if (btn.tagName === "A" && btn.href) {
          window.location.replace(btn.href); // use the real href (skips flaky JS handlers)
        } else {
          btn.click();
          // safety net: if the click didn't navigate, force it.
          setTimeout(() => { if (isOGameXErrorPage()) window.location.replace("/"); }, 5000);
        }
        return;
      }
      window.location.replace("/"); // last resort
    }, backoff);

    // ── v2.61.0: error-page guard ──
    // Incident 2026-08-03 (×2): the bot sat on this page for HOURS, because the whole
    // recovery path hung on a SINGLE setTimeout — and the browser
    // in a background tab throttles timers to ~1/min, and with memory saving
    // it can even drop them. One lost timer = a dead bot until a manual F5.
    // The interval retries every ~60 s as long as the error page stands;
    // the 70-second barrier doesn't duplicate the attempt the timeout above has in flight.
    // After 6 failed attempts, escalate to "/" — init knows how to handle the lobby
    // page separately (click on Play), so this is the way out of the overview→404 loop.
    if (!window.__ogxErrWatch) {
      window.__ogxErrWatch = setInterval(() => {
        try {
          if (!isOGameXErrorPage()) { clearInterval(window.__ogxErrWatch); window.__ogxErrWatch = null; return; }
          const lastTry = parseInt(GM_getValue("ogamex_error_recover_at", "0")) || 0;
          if (Date.now() - lastTry < 70 * 1000) return;
          const streakNow = (parseInt(GM_getValue("ogamex_error_recover_streak", "0")) || 0) + 1;
          GM_setValue("ogamex_error_recover_at", String(Date.now()));
          GM_setValue("ogamex_error_recover_streak", String(streakNow));
          log(`Error-page guard: retrying return to the game (attempt ${streakNow}).`, "warn");
          if (streakNow >= 6) { window.location.replace("/"); return; }
          const btn = findBackToGameButton();
          if (btn && btn.tagName === "A" && btn.href) window.location.replace(btn.href);
          else if (btn) btn.click();
          else window.location.replace("/");
        } catch {}
      }, 60 * 1000);
    }

    // v2.61.0: the defense loop also starts HERE. An error page doesn't mean that
    // the whole server is down — /overview can return 404 while the rest of the routes are alive.
    // The threat check goes via fetch (list of fleet movements), so it works without
    // the mission bar, and the rescue navigates straight to the fleet form. In the worst
    // case the fetch fails and the loop is cheap while idle; in the best — the bot
    // defends the fleet even when the page underneath it has crashed.
    try { startDefenceLoop(); } catch {} // v2.69.1: the watcher stays on duty even with OFF

    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  ANTI-DETECTION: Human-like delays
  // ═══════════════════════════════════════════════════════════════

  const AntiDetection = {
    // Gaussian-distributed random delay
    gaussianRandom(mean, stddev) {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      return Math.max(0, mean + z * stddev);
    },

    // Random delay between min and max seconds (gaussian distribution)
    async delay(label = "action") {
      const { minDelaySeconds, maxDelaySeconds } = CONFIG.antiDetection;
      const mean = (minDelaySeconds + maxDelaySeconds) / 2;
      const stddev = (maxDelaySeconds - minDelaySeconds) / 4;
      const seconds = Math.max(minDelaySeconds, Math.min(maxDelaySeconds, this.gaussianRandom(mean, stddev)));
      log(`Waiting ${Math.round(seconds)}s before ${label}...`, "delay");
      await this.sleep(seconds * 1000);
    },

    // Short delay (2-8 seconds) for between-page navigation
    async shortDelay() {
      const ms = 2000 + Math.random() * 6000;
      await this.sleep(ms);
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Check if we should be sleeping (night hours)
    isSleepTime() {
      const { sleepStartHour, sleepEndHour } = CONFIG.antiDetection;
      if (sleepStartHour === sleepEndHour) return false; // disabled
      // v2.12.0: minute-granular with a DAILY ±20min jitter per boundary — a
      // bot that goes quiet at exactly HH:00:00 every night is a fingerprint.
      // Offsets are generated once per UTC day and persisted.
      let jit = null;
      const today = new Date().toISOString().slice(0, 10);
      try { jit = JSON.parse(GM_getValue("ogamex_sleep_jitter", "null")); } catch {}
      if (!jit || jit.date !== today) {
        jit = {
          date: today,
          startOff: Math.round((Math.random() * 40) - 20), // ±20 min
          endOff: Math.round((Math.random() * 40) - 20),
        };
        GM_setValue("ogamex_sleep_jitter", JSON.stringify(jit));
      }
      // v2.16.2: LOCAL time, not UTC. The window exists to make the account
      // look asleep when its owner is asleep, and the owner thinks in the
      // clock on their wall (which is also the clock the game shows). UTC also
      // drifts against local time twice a year with DST — the night window
      // would silently shift by an hour. The stored numbers are now local
      // hours: 23 and 5 mean 23:00-05:00 where the player lives.
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const norm = (m) => ((m % 1440) + 1440) % 1440;
      const startMin = norm(sleepStartHour * 60 + jit.startOff);
      const endMin = norm(sleepEndHour * 60 + jit.endOff);
      if (startMin === endMin) return false;
      if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
      return nowMin >= startMin || nowMin < endMin;
    },

    // Random jitter: occasionally do nothing for 5-15 minutes
    shouldJitter() {
      return CONFIG.antiDetection.jitterEnabled && Math.random() < 0.1; // 10% chance
    },

    async jitter() {
      if (!this.shouldJitter()) return;
      const minutes = 5 + Math.random() * 10;
      log(`Jitter pause: ${Math.round(minutes)}m (simulating idle player)`, "delay");
      await this.sleep(minutes * 60 * 1000);
    },
  };

  // Action rate limiter — max 10 actions per hour (persisted across page reloads)
  const RateLimiter = {
    maxPerHour: 20,
    KEY: "ogamex_rate_actions",

    _load() {
      try {
        const raw = GM_getValue(this.KEY, "[]");
        return JSON.parse(raw).filter(t => t > Date.now() - 60 * 60 * 1000);
      } catch { return []; }
    },

    _save(actions) {
      GM_setValue(this.KEY, JSON.stringify(actions));
    },

    canAct() {
      return this._load().length < this.maxPerHour;
    },

    record() {
      const actions = this._load();
      actions.push(Date.now());
      this._save(actions);
    },

    remaining() {
      return this.maxPerHour - this._load().length;
    },
  };

  // Navigation rate limiter — caps total bot-initiated page loads per hour.
  // RateLimiter above counts only fleet dispatches (~1-3/h). Scan traffic
  // (/galaxy?x=&y= page loads + AJAX fetches) is invisible to it — a full
  // 300-system scan can push ~300 requests in 7-8 minutes. NavRateLimiter
  // closes that gap so the scan pauses itself before looking bot-like.
  const NavRateLimiter = {
    maxPerHour: 450,
    KEY: "ogamex_nav_actions",

    _load() {
      try {
        const raw = GM_getValue(this.KEY, "[]");
        return JSON.parse(raw).filter(t => t > Date.now() - 60 * 60 * 1000);
      } catch { return []; }
    },

    _save(actions) {
      GM_setValue(this.KEY, JSON.stringify(actions));
    },

    record() {
      const actions = this._load();
      actions.push(Date.now());
      this._save(actions);
    },

    count() {
      return this._load().length;
    },

    canNavigate() {
      return this._load().length < this.maxPerHour;
    },

    // ms until oldest action rolls off — used to schedule resume after cap hit.
    millisUntilReset() {
      const actions = this._load();
      if (actions.length < this.maxPerHour) return 0;
      const oldest = Math.min(...actions);
      return Math.max(0, (oldest + 60 * 60 * 1000) - Date.now());
    },
  };

  // Navigate, first checking the nav cap. On cap hit, persists a pause timer
  // and returns false — caller must `return` and let the scheduler retry
  // after the pause window. ScanState is preserved so the queue resumes.
  // Returns true when navigation was committed (page is about to unload).
  function scanNavigate(url, context = "scan") {
    if (!NavRateLimiter.canNavigate()) {
      const waitMs = Math.max(NavRateLimiter.millisUntilReset() + 60 * 1000, 10 * 60 * 1000);
      GM_setValue("ogamex_nav_pause_until", String(Date.now() + waitMs));
      log(`Nav cap hit (${NavRateLimiter.count()}/${NavRateLimiter.maxPerHour}). Pausing ${Math.ceil(waitMs/60000)}min before ${context}.`, "warn");
      return false;
    }
    NavRateLimiter.record();
    // v2.93.0: replace() instead of href= in ALL bot programmatic navigations
    // The bot does thousands of reloads a day; every href= adds an entry
    // to the tab history, and Firefox serializes session history in the background - after
    // a few hours the whole browser was sluggish (owner observation 15.08).
    // For the server it's an identical GET; replace() simply doesn't grow the history.
    window.location.replace(url);
    return true;
  }

  // v2.10.9: human-pace delay between galaxy-system scans. Was 250-650ms — a
  // clear bot-tell (no human clicks through systems twice a second, and it
  // meant ~124 galaxy page-loads per sweep at machine speed). 2-6s + the
  // existing 10% jitter pause looks like a person checking nearby belts.
  // Balances stealth vs throughput (owner choice 2026-06-08). The
  // closest-range-first scan ORDER is unchanged — only the pacing.
  function humanScanDelayMs() {
    return 1000 + Math.random() * 2000;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GAME STATE: Parse current game data from DOM
  // ═══════════════════════════════════════════════════════════════

  const GameState = {
    // Get CSRF token for AJAX requests
    getToken() {
      return (
        document.querySelector('meta[name="csrf-token"]')?.content ||
        document.querySelector('input[name="_token"]')?.value ||
        (typeof window !== "undefined" && window.token) ||
        ""
      );
    },

    // Get current resources
    getResources() {
      const parse = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return 0;
        const text = el.textContent.replace(/[.\s]/g, "").replace(/,/g, "");
        return parseInt(text, 10) || 0;
      };
      return {
        metal: parse("#resources_metal") || parse('[id*="metal"] .value') || 0,
        crystal: parse("#resources_crystal") || parse('[id*="crystal"] .value') || 0,
        deuterium: parse("#resources_deuterium") || parse('[id*="deuterium"] .value') || 0,
      };
    },

    // Get list of player's planets from right sidebar
    // Sidebar: "[26/26] Planets" header, each planet has coords like [6:476:9]
    // IMPORTANT: Must NOT pick up coords from the galaxy table (other players)
    getPlanets() {
      const planets = [];
      const seen = new Set();

      // The right sidebar planet entries are inside the planet list area
      // They are NOT inside .galaxy-content or .galaxy-item
      // Look for coord patterns only in elements that are NOT in the galaxy table
      document.querySelectorAll("a, div, span").forEach((el) => {
        // Skip anything inside galaxy content area
        if (el.closest(".galaxy-content, .galaxy-item, .galaxy-info")) return;

        const text = el.textContent;
        // Only match elements whose DIRECT text is short (planet entry, not container)
        if (text.length > 80) return;

        const match = text.match(/\[(\d+):(\d+):(\d+)\]/);
        if (!match) return;

        const galaxy = parseInt(match[1]);
        const system = parseInt(match[2]);
        const position = parseInt(match[3]);
        const key = `${galaxy}:${system}:${position}`;
        if (seen.has(key)) return;

        const name = text.replace(/\[.*\]/, "").replace(/\s+/g, " ").trim() || "Planet";

        seen.add(key);
        planets.push({
          galaxy, system, position, name,
          link: el.tagName === "A" ? el.href : el.closest("a")?.href || null,
        });
      });

      // Only log when count changes — getPlanets is called many times per cycle
      if (planets.length !== this._lastPlanetCount) {
        if (planets.length > 0) {
          log(`Parsed ${planets.length} planets`, "info");
        } else {
          log("Could not parse planets from sidebar", "error");
        }
        this._lastPlanetCount = planets.length;
      }
      return planets;
    },
    _lastPlanetCount: -1,

    // Get current (active) planet coordinates from page.
    // IMPORTANT: do NOT fall back to URL ?x=&y= — on /fleet and /galaxy those are
    // the TARGET coords, not the active source planet, which corrupts callers
    // tracking which planets they've already tried.
    getCurrentPlanet() {
      // Try highlighted planet in right sidebar (has different styling)
      const activePlanet = document.querySelector('[class*="active"] [class*="planet"], .active-planet, [class*="selected"]');
      if (activePlanet) {
        const match = activePlanet.textContent.match(/\[(\d+):(\d+):(\d+)\]/);
        if (match) return { galaxy: +match[1], system: +match[2], position: +match[3] };
      }
      // Try common selectors
      const coordEl = document.querySelector(".planet-header .coords, .current-planet .coords, [class*='planet-name']");
      if (coordEl) {
        const match = coordEl.textContent.match(/\[(\d+):(\d+):(\d+)\]/);
        if (match) return { galaxy: +match[1], system: +match[2], position: +match[3] };
      }
      return null;
    },

    // Get fleet slots info (from fleet page header area, not full body)
    getFleetSlots() {
      const text = document.body.textContent;
      const match = text.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
      if (match) return { used: parseInt(match[1]), total: parseInt(match[2]) };
      return { used: 0, total: 1 };
    },

    // Get expedition slots
    getExpeditionSlots() {
      const text = document.body.textContent;
      const match = text.match(/Expeditions:\s*(\d+)\s*\/\s*(\d+)/);
      if (match) return { used: parseInt(match[1]), total: parseInt(match[2]) };
      return { used: 0, total: 1 };
    },

    // Get available ships on current planet
    getAvailableShips() {
      const ships = {};
      document.querySelectorAll(".ship-item, [data-ship-type]").forEach((el) => {
        const type = el.dataset?.shipType;
        const qty = parseInt(el.dataset?.shipQuantity || el.querySelector(".ship-quantity, .quantity")?.textContent?.replace(/[.\s,]/g, "") || "0");
        if (type && qty > 0) {
          ships[type] = qty;
        }
      });
      return ships;
    },

    // Check current page
    getCurrentPage() {
      const path = window.location.pathname;
      if (path.includes("/fleet")) return "fleet";
      if (path.includes("/galaxy")) return "galaxy";
      if (path.includes("/overview")) return "overview";
      return path.replace("/", "") || "unknown";
    },

    // Check for active missions
    getActiveMissions() {
      const missionText = document.body.textContent;
      const match = missionText.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
      if (match) {
        return { total: parseInt(match[1]), own: parseInt(match[2]) };
      }
      return { total: 0, own: 0 };
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLIGHT CALIBRATION (v2.99.0) — miner flight time learned per server
  // ═══════════════════════════════════════════════════════════════
  // estimateFlightMinutes used constants from a two-point calibration on athena
  // (fleet x4). Genesis runs fleet x3 → flights ~4/3 longer, so the fixed formula
  // UNDERESTIMATES the arrival time and the TTL gate sends miners to asteroids that
  // vanish before arrival. The bot reads the REAL flight time from the form anyway
  // at step 2 (capturedFlightMs, v2.66.8) — here we store pairs
  // (Δ systems, minutes) into a per-host store, and after ≥2 samples with
  // a spread of ≥20 systems we compute our own fit a + b·Δ (least squares).
  // We learn EXCLUSIVELY from asteroid_mining_direct missions (one ship type,
  // 100% speed) — farms/expeditions/rescues would poison the fit.
  // Until trained: the old athena formula (fail-safe, conservative on x4).
  // ── FLIGHT-CAL-START ──
  const FlightCalibration = {
    KEY: "ogamex_flight_cal",
    MAX_SAMPLES: 30,
    MIN_SPREAD: 20,     // minimum Δ spread between samples — without it the slope is noise
    _cache: null,       // { n, fit } — fit() is called on every scan planning

    load() {
      try { const raw = GM_getValue(this.KEY, null); const st = raw ? JSON.parse(raw) : null; return st && Array.isArray(st.samples) ? st : { samples: [] }; }
      catch { return { samples: [] }; }
    },
    save(st) { GM_setValue(this.KEY, JSON.stringify(st)); this._cache = null; },

    // dist: Δ systems (same galaxy), minutes: real one-way time from the form
    record(dist, minutes) {
      if (!Number.isFinite(dist) || dist < 0 || dist > 499) return false;
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) return false;
      const st = this.load();
      st.samples.push({ d: dist, m: Math.round(minutes * 10) / 10, at: Date.now() });
      if (st.samples.length > this.MAX_SAMPLES) st.samples = st.samples.slice(-this.MAX_SAMPLES);
      this.save(st);
      log(`[CALIBRATION] miner flight Δ${dist} → ${minutes.toFixed(1)} min (samples: ${st.samples.length})`, "asteroid");
      return true;
    },

    // Fit m = a + b·Δ; null = too little data → athena formula
    fit() {
      const st = this.load();
      const s = st.samples;
      if (this._cache && this._cache.n === s.length) return this._cache.fit;
      let fit = null;
      if (s.length >= 2) {
        const dMin = Math.min(...s.map(x => x.d)), dMax = Math.max(...s.map(x => x.d));
        if (dMax - dMin >= this.MIN_SPREAD) {
          const n = s.length;
          const sumD = s.reduce((a, x) => a + x.d, 0), sumM = s.reduce((a, x) => a + x.m, 0);
          const meanD = sumD / n, meanM = sumM / n;
          const varD = s.reduce((a, x) => a + (x.d - meanD) ** 2, 0);
          const cov = s.reduce((a, x) => a + (x.d - meanD) * (x.m - meanM), 0);
          let b = cov / varD;
          if (b < 0) b = 0; // farther ≠ faster — a negative slope is measurement noise
          const a = meanM - b * meanD;
          if (a > 0) fit = { a, b };
        }
      }
      this._cache = { n: s.length, fit };
      return fit;
    },

    // Estimate in minutes with a safety margin (+2 min, ceiling) —
    // the TTL gate would rather skip an asteroid than send miners into a despawn.
    estimate(dist) {
      const f = this.fit();
      if (!f) return null;
      return Math.max(3, Math.ceil(f.a + f.b * dist) + 2);
    },
  };
  // ── FLIGHT-CAL-END ──

  // ═══════════════════════════════════════════════════════════════
  //  ASTEROID SCANNER: 2-stage — ranges then galaxy page navigation
  //  Stage 1: Fetch ranges via AJAX (Partial_AsteroidLocation)
  //  Stage 2: Navigate galaxy page system-by-system, read live DOM
  // ═══════════════════════════════════════════════════════════════

  const AsteroidScanner = {
    // ── Stage 1: Parse ranges from "Find asteroids" (AJAX — works) ──
    // skipDelay: pass true when calling multiple times in a row to avoid
    // stacking anti-detection sleeps unnecessarily
    async scanRanges(skipDelay = false) {
      log("Fetching asteroid ranges...", "asteroid");
      if (!skipDelay) {
        await AntiDetection.sleep(2000 + Math.random() * 5000);
      }
      try {
        const response = await fetch("/galaxy/Partial_AsteroidLocation", {
          headers: { "X-Requested-With": "XMLHttpRequest", Accept: "*/*" },
          credentials: "same-origin",
        });

        if (!response.ok) {
          log(`Asteroid range fetch failed: HTTP ${response.status}`, "error");
          return null; // v2.12.7: error ≠ empty — don't let a failed fetch read as "no ranges"
        }

        const html = await response.text();
        log(`[DEBUG] AsteroidLocation HTML (${html.length}ch): ${html.substring(0, 200)}`, "info");

        // v2.10.10: session-loss detection. When the game session expires
        // (e.g. after the 45min no-asteroid cooldown idled with zero requests),
        // this fetch follows the auth redirect and returns the LOGIN page with
        // HTTP 200 — which parses as "0 ranges". Without this check the bot
        // keeps polling forever, blind, and never finds another asteroid until
        // a manual reload. A real page load restores the session (remember-me)
        // or lands on /home where init() correctly stays off.
        // Reload is rate-limited to 1/30min so an unexpected-but-valid empty
        // response can't cause a reload loop.
        if (response.redirected || !/galaxy-asteroid-modal|asteroid-modal-desc|playerAste/i.test(html)) {
          log(`Range fetch returned a non-game page (redirected=${response.redirected}) — session expired / logged out?`, "error");
          const lastSessionReload = parseInt(GM_getValue("ogamex_session_reload_at", "0"));
          if (Date.now() - lastSessionReload > 30 * 60 * 1000) {
            GM_setValue("ogamex_session_reload_at", String(Date.now()));
            log("Reloading page to restore session...", "warn");
            setTimeout(() => window.location.reload(), 2000 + Math.random() * 3000);
          }
          return null; // v2.12.7: unknown state, not a verified-empty pool
        }

        const ranges = AsteroidScanner.parseRangesFromHtml(html);

        if (ranges.length === 0) {
          log("No asteroid ranges found", "asteroid");
        } else {
          const labels = ranges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
          log(`Found ${ranges.length} asteroid ranges: ${labels}`, "asteroid");
        }

        return ranges;
      } catch (err) {
        // v2.12.7: observed live at 05:01 — a transient NetworkError returned
        // [] here, the per-step verify read it as "no active ranges" and
        // KILLED a sweep at 121/155 systems. Errors must be "unknown" (null),
        // never "verified empty"; only a parsed no-asteroid response is [].
        log(`Asteroid range scan error: ${err.message}`, "error");
        return null;
      }
    },

    // ── Parse "[g:s:p] ? [g:s:p]" pairs into ranges ── (extracted v2.12.5)
    // Each consecutive coordinate pair = one independent search area. Do NOT
    // merge overlapping ranges — merging loses information and can cause the
    // bot to scan outside the intended boundaries.
    parseRangesFromHtml(html) {
      const coords = [];
      const regex = /\[(\d+):(\d+):(\d+)\]/g;
      let match;
      while ((match = regex.exec(html)) !== null) {
        coords.push({ galaxy: parseInt(match[1]), system: parseInt(match[2]) });
      }
      const rawRanges = [];
      for (let i = 0; i + 1 < coords.length; i += 2) {
        const a = coords[i], b = coords[i + 1];
        if (a.galaxy === b.galaxy) {
          rawRanges.push({
            galaxy: a.galaxy,
            startSystem: Math.min(a.system, b.system),
            endSystem: Math.max(a.system, b.system),
          });
        }
      }
      rawRanges.sort((a, b) => a.galaxy - b.galaxy || a.startSystem - b.startSystem);
      return rawRanges;
    },

    // ── Stage 1c: click the game's OWN "Find asteroids" button ── (v2.12.5)
    // Observed live (20:38): the bare Partial_AsteroidLocation GET returned
    // "no signs of asteroids" 3× in a row, while a MANUAL click on the row-17
    // button one minute later showed FIVE ranges. The button's click handler
    // evidently does more than a bare read (fresh research roll / different
    // request). Clicking the real button replicates exactly what the game —
    // and a human player — does. Only available on a galaxy page where row 17
    // shows the button (i.e. no asteroid currently occupies the belt).
    async scanRangesViaButton() {
      const btn = document.querySelector("span.x-find-asteroid, span.btn-asteroid-find");
      if (!btn) return null; // not on a galaxy page / button not present
      log("Bare range fetch came back empty — clicking the game's 'Find asteroids' button instead (human path).", "asteroid");
      // Drop any stale modal so the poll below can't read a pre-click leftover
      document.querySelectorAll(".galaxy-asteroid-modal").forEach(el => el.remove());
      await AntiDetection.sleep(800 + Math.random() * 1200);
      btn.click();
      // Poll for the modal the game renders (up to ~6s)
      let modal = null;
      for (let i = 0; i < 12; i++) {
        await AntiDetection.sleep(500);
        modal = document.querySelector(".galaxy-asteroid-modal");
        if (modal) break;
      }
      if (!modal) {
        log("Find-asteroids modal did not appear within 6s — falling back to empty result.", "warn");
        return [];
      }
      await AntiDetection.sleep(700 + Math.random() * 1000); // human reads the modal
      const ranges = this.parseRangesFromHtml(modal.outerHTML);
      // Close like a human: prefer a real close control, else drop the node.
      // (Leftover DOM is harmless anyway — the next scan step is a full page load.)
      const dialog = modal.closest("dialog, [class*='modal-wrap'], [class*='dialog'], [class*='popup']") || modal;
      const closeBtn = dialog.querySelector("[class*='close'], button[aria-label='Close']")
        || [...dialog.querySelectorAll("button, span, a")].find(el => /^[×✕x]$/i.test((el.textContent || "").trim()));
      if (closeBtn) closeBtn.click(); else modal.remove();
      if (ranges.length > 0) {
        const labels = ranges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
        log(`Button scan found ${ranges.length} asteroid ranges: ${labels}`, "asteroid");
      } else {
        log("Button scan: modal shows no ranges either — hint pool genuinely empty.", "asteroid");
      }
      return ranges;
    },

    // ── Stage 1b: Deep fetch — call scanRanges N times to build the authoritative
    // range set. Single calls return a random subset of the pool, so one call can
    // silently omit an active range. Used by startNewScan AND re-check so the
    // re-check has enough confidence to DROP stale ranges that didn't reappear.
    async scanRangesFull(maxCalls = 6) {
      const allRanges = [];
      const seen = new Set();
      let prevCount = 0;
      for (let call = 0; call < maxCalls; call++) {
        if (call > 0) await AntiDetection.sleep(800 + Math.random() * 1200);
        const batch = await AsteroidScanner.scanRanges(call > 0);
        if (batch === null) continue; // v2.12.7: errored call = no information, not "empty"
        for (const r of batch) {
          const key = `${r.galaxy}:${r.startSystem}-${r.endSystem}`;
          if (!seen.has(key)) {
            seen.add(key);
            allRanges.push(r);
          }
        }
        if (allRanges.length === prevCount && call >= 2) {
          log(`Deep fetch: no new ranges after ${call + 1} calls, stopping`, "asteroid");
          break;
        }
        prevCount = allRanges.length;
      }
      // v2.12.5: empty result → try the game's own "Find asteroids" button
      // (see scanRangesViaButton). The bare GET provably under-reports when
      // the hint pool needs a fresh research roll.
      if (allRanges.length === 0) {
        const viaButton = await AsteroidScanner.scanRangesViaButton();
        if (viaButton && viaButton.length > 0) return viaButton;
      }
      allRanges.sort((a, b) => a.galaxy - b.galaxy || a.startSystem - b.startSystem);
      return allRanges;
    },

    // ── Stage 2: Check position 17 in LIVE DOM (current galaxy page) ──
    // Returns: { found: true, fleetUrl: "/fleet?x=6&y=84&z=17&mission=12",
    //            ttlSeconds: 353 } or { found: false }
    // ttlSeconds comes from data-asteroid-disappear (game's own countdown).
    // Caller MUST compare it against estimated flight time before dispatch
    // — otherwise we burn deuter on asteroids that vanish mid-flight.
    checkCurrentPageForAsteroid() {
      const items = document.querySelectorAll(".galaxy-item");
      const totalRows = items.length;

      // Log DOM state for debugging — helps diagnose missed detections
      log(`[DOM] galaxy-item rows found: ${totalRows}`, "fleet");

      if (totalRows === 0) {
        log("[DOM] No .galaxy-item rows! Page not fully rendered yet.", "error");
        return { found: false };
      }

      for (const item of items) {
        const idx = item.querySelector(".planet-index");
        if (!idx) continue;
        const posText = idx.textContent.trim();
        if (posText !== "17") continue;

        // Found row 17 — log full HTML for analysis
        const rowHtml = item.innerHTML.replace(/\s+/g, " ").trim().substring(0, 600);
        log(`[DOM] Row 17 HTML: ${rowHtml}`, "fleet");

        // ── Quick exit: "Find asteroids" button means NO asteroid here ──
        const findBtn = item.querySelector("span.x-find-asteroid, span.btn-asteroid-find");
        if (findBtn) {
          log(`Pos17: no asteroid (Find asteroids button present)`, "asteroid");
          return { found: false };
        }

        // Helper: read TTL seconds from any data-asteroid-disappear elem,
        // fall back to parsing (MM:SS) from row text. Returns null if neither.
        const parseTtlSeconds = () => {
          const el = item.querySelector("[data-asteroid-disappear]");
          if (el) {
            const n = parseInt(el.getAttribute("data-asteroid-disappear") || "", 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
          const txt = (item.textContent || "").replace(/\s+/g, " ").trim();
          const m = txt.match(/\((\d{1,2}):(\d{2})\)/);
          if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          return null;
        };

        // ── Method 1: a.btn-asteroid or mission=12 link (direct fleet URL) ──
        const asteroidLink = item.querySelector("a.btn-asteroid, a[href*='mission=12']");
        if (asteroidLink) {
          const href = asteroidLink.getAttribute("href") || "";
          const ttlSeconds = parseTtlSeconds();
          log(`ASTEROID FOUND! Fleet URL: ${href} | TTL: ${ttlSeconds ?? "?"}s`, "success");
          return { found: true, fleetUrl: href, ttlSeconds };
        }

        // ── Method 2: data-asteroid-disappear timer element ──
        const timerEl = item.querySelector("[data-asteroid-disappear]");
        if (timerEl) {
          const ttlSeconds = parseTtlSeconds();
          log(`ASTEROID FOUND (timer attr)! TTL: ${ttlSeconds ?? "?"}s`, "success");
          const urlMatch = window.location.href.match(/[?&]x=(\d+).*?[?&]y=(\d+)/);
          const reconstructed = urlMatch
            ? `/fleet?x=${urlMatch[1]}&y=${urlMatch[2]}&z=17&mission=12`
            : null;
          return { found: true, fleetUrl: reconstructed, ttlSeconds };
        }

        // ── Method 3: text-based — timer pattern (MM:SS) in row 17 ──
        const rowText = (item.textContent || "").replace(/\s+/g, " ").trim();
        const timerMatch = rowText.match(/\((\d{1,2}:\d{2})\)/);
        if (timerMatch) {
          const ttlSeconds = parseTtlSeconds();
          const urlMatch = window.location.href.match(/[?&]x=(\d+).*?[?&]y=(\d+)/);
          const reconstructed = urlMatch
            ? `/fleet?x=${urlMatch[1]}&y=${urlMatch[2]}&z=17&mission=12`
            : null;
          log(`ASTEROID FOUND (text timer)! TTL: ${ttlSeconds ?? "?"}s, url: ${reconstructed}`, "success");
          return { found: true, fleetUrl: reconstructed, ttlSeconds };
        }

        // No asteroid at position 17
        log(`Pos17: no asteroid (rows=${totalRows}, text="${rowText.substring(0, 80)}")`, "asteroid");
        return { found: false };
      }

      // Row 17 not found in DOM at all
      log(`[DOM] Pos17 row NOT found! Total rows: ${totalRows}. Selectors may have changed.`, "error");
      // Log all available position indices for diagnostics
      const allPos = [...items].map(i => i.querySelector(".planet-index")?.textContent?.trim() || "?").join(",");
      log(`[DOM] Available positions: ${allPos}`, "fleet");
      return { found: false };
    },

    // ── Build scan queue: all systems in all ranges, sorted by distance ──
    // v2.9.1: scan order = closest-to-base first. With 5 active ranges
    // spread across the galaxy, scanning ascending-by-system can spend
    // minutes walking a range 200+ systems from base before discovering
    // an asteroid right next door. Asteroids have a TTL (game-side) and
    // miner flight is one-way 1-25min depending on distance, so every
    // second wasted on far ranges first costs us catches.
    //
    // Filters out systems whose estimated one-way flight exceeds
    // maxFlightMinutes (no point queueing what we can't dispatch).
    // Same-galaxy systems always sort before cross-galaxy.
    buildScanQueue(ranges, base = null, maxFlightMinutes = null) {
      // v2.12.6: a range whose asteroid we already dispatched to is DONE for
      // as long as the fleet is en route (live DispatchedAsteroids entry) —
      // "one asteroid per range" means walking its other systems finds
      // nothing, and re-walking a harvested range minutes later is pure
      // bot-tell traffic. The entry expires at fleet ARRIVAL, so the range
      // returns to rotation exactly when a fresh spawn becomes possible.
      //
      // v2.12.8: one en-route fleet cancels AT MOST ONE range. The old
      // filter dropped every range containing ANY dispatched coord, so with
      // overlapping hints a single fleet killed several ranges at once
      // (observed: [3:13] en route excluded BOTH [3:9-29] and [3:12-32] —
      // two hint rows = two asteroids, and the second, unclaimed one was
      // never scanned; the bot then reported "no asteroids" while the game
      // modal still listed its range). Maximum bipartite matching between
      // dispatched coords and the ranges that contain them: only matched
      // ranges are dropped, every surplus range stays in the queue.
      //
      // v2.12.9: matching, but only over coords whose range is CERTAIN. A
      // coord inside the overlap of two hints could belong to either one, and
      // dropping the wrong one takes an unclaimed asteroid's whole search area
      // out of the sweep (same failure mode pruneFoundRange had). An ambiguous
      // en-route coord therefore excludes NOTHING — re-walking a possibly
      // harvested range costs page loads; the coord itself can never get a
      // second fleet, because the dispatch path re-checks DispatchedAsteroids
      // .has() live on the galaxy page before every send.
      const covers = (c, r) => c.galaxy === r.galaxy && c.system >= r.startSystem && c.system <= r.endSystem;
      const blocked = DispatchedAsteroids.coords().filter(c => {
        const containing = ranges.filter(r => covers(c, r));
        if (containing.length <= 1) return true;
        const labels = containing.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(" / ");
        log(`En-route asteroid [${c.galaxy}:${c.system}:17] is inside ${containing.length} overlapping ranges (${labels}) — ambiguous, so none of them is excluded from the scan.`, "asteroid");
        return false;
      });
      const matchedBy = new Array(ranges.length).fill(-1); // range idx → blocked idx
      const tryAssign = (bi, visited) => {
        for (let ri = 0; ri < ranges.length; ri++) {
          if (visited.has(ri) || !covers(blocked[bi], ranges[ri])) continue;
          visited.add(ri);
          if (matchedBy[ri] === -1 || tryAssign(matchedBy[ri], visited)) {
            matchedBy[ri] = bi;
            return true;
          }
        }
        return false;
      };
      for (let bi = 0; bi < blocked.length; bi++) tryAssign(bi, new Set());
      const liveRanges = ranges.filter((r, ri) => {
        if (matchedBy[ri] === -1) return true;
        const hit = blocked[matchedBy[ri]];
        log(`Range [${r.galaxy}:${r.startSystem}-${r.endSystem}] excluded — asteroid [${hit.galaxy}:${hit.system}:17] already dispatched, fleet en route.`, "asteroid");
        return false;
      });
      // Stats for the caller: lets startScan tell "everything is already
      // being mined" (normal) apart from "queue truly empty" (config issue).
      this.lastQueueStats = {
        totalRanges: ranges.length,
        fleetExcluded: ranges.length - liveRanges.length,
      };

      // Sort ranges so the closest one (to base) is scanned first,
      // but stay sequential ascending inside each range — otherwise we
      // interleave systems across ranges when two ranges have overlapping
      // distance bands (e.g. [185-209] and [331-355] from base 269).
      const sortedRanges = [...liveRanges];
      if (base) {
        sortedRanges.sort((a, b) => {
          const aSame = a.galaxy === base.galaxy;
          const bSame = b.galaxy === base.galaxy;
          if (aSame !== bSame) return aSame ? -1 : 1;
          if (a.galaxy !== b.galaxy) return a.galaxy - b.galaxy;
          const aDist = a.endSystem < base.system
            ? base.system - a.endSystem
            : a.startSystem > base.system
              ? a.startSystem - base.system
              : 0;
          const bDist = b.endSystem < base.system
            ? base.system - b.endSystem
            : b.startSystem > base.system
              ? b.startSystem - base.system
              : 0;
          return aDist - bDist;
        });
      } else {
        sortedRanges.sort((a, b) => a.galaxy - b.galaxy || a.startSystem - b.startSystem);
      }

      const seen = new Set();
      const queue = [];
      for (const range of sortedRanges) {
        for (let s = range.startSystem; s <= range.endSystem; s++) {
          const key = `${range.galaxy}:${s}`;
          if (seen.has(key)) continue;
          seen.add(key);

          if (base && maxFlightMinutes != null && range.galaxy === base.galaxy) {
            const dist = Math.abs(s - base.system);
            if (AsteroidScanner.estimateFlightMinutes(dist) > maxFlightMinutes) {
              continue;
            }
          }
          queue.push({ galaxy: range.galaxy, system: s });
        }
      }
      return queue;
    },

    // ── Helper: find closest planet to a coordinate ──
    findClosestPlanet(coord, planets) {
      let closest = null, minDist = Infinity;
      for (const planet of planets) {
        if (planet.galaxy !== coord.galaxy) continue;
        const dist = Math.abs(planet.system - coord.system);
        if (dist < minDist) { minDist = dist; closest = planet; }
      }
      return { planet: closest, distance: minDist };
    },

    // ASTEROID_MINER flight time has a large fixed overhead (~10min warmup
    // + base flight) plus a small linear distance component. Single-rate
    // formulas are very wrong at small distances — v2.9.3 used /9 which
    // gave 2min for Δ=13 when reality is ~11min, leaving zero safety
    // margin on short-TTL asteroids.
    //
    // Two-point calibration on athena (2026-05-21):
    //   Δ=13  sys (3:269 → 3:256) → ~11min one-way (countdown 10m49s ×2)
    //   Δ=217 sys (3:269 → 3:52)  → ~24min one-way (countdown 23m54s ×2)
    // Linear fit: time_min ≈ 10.5 + 0.064 × distance. Round up + floor at
    // 11 so we never under-estimate even for adjacent systems.
    // v2.99.0: first the fit learned from real flights ON THIS server
    // (FlightCalibration, per-host — Genesis fleet x3 ≠ athena x4); the athena
    // constants remain as a fallback until ≥2 samples with a sensible spread.
    estimateFlightMinutes(systemDistance) {
      const learned = FlightCalibration.estimate(systemDistance);
      if (learned !== null) return learned;
      return Math.max(11, Math.ceil(11 + systemDistance / 15));
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  GALAXY SCAN STATE: Persisted across page navigations
  // ═══════════════════════════════════════════════════════════════

  const ScanState = {
    KEY: "ogamex_scan_state",

    load() {
      try {
        const raw = GM_getValue(this.KEY, null);
        if (!raw) return null;
        const state = JSON.parse(raw);
        // Expire scans older than 120 minutes (large ranges + dispatch + delays)
        if (state.active && Date.now() - state.startedAt > 120 * 60 * 1000) {
          log("Scan expired (>120min), clearing", "warn");
          this.clear();
          return null;
        }
        return state;
      } catch { return null; }
    },

    save(state) {
      GM_setValue(this.KEY, JSON.stringify(state));
    },

    clear() {
      GM_setValue(this.KEY, null);
    },

    // Start a new scan
    start(ranges, queue) {
      this.save({
        active: true,
        ranges,
        queue,           // [{galaxy, system}, ...] — remaining systems to scan
        scannedCount: 0,
        totalCount: queue.length,
        scannedSystems: [], // track scanned systems for range re-fetch dedup
        foundAsteroid: null,
        startedAt: Date.now(),
        lastRangeCheckAt: Date.now(),
        lastDeepFetchCount: 0,
      });
    },

    // Mark current system as scanned, advance to next
    advance(state) {
      const done = state.queue.shift();
      if (done) {
        if (!state.scannedSystems) state.scannedSystems = [];
        state.scannedSystems.push({ galaxy: done.galaxy, system: done.system });
      }
      state.scannedCount++;
      this.save(state);
    },

    // Mark asteroid found (keep scan active so it resumes after dispatch)
    markFound(state, galaxy, system, ttlSeconds = null) {
      state.foundAsteroid = {
        galaxy,
        system,
        position: 17,
        label: `[${galaxy}:${system}:17]`,
        ttlSeconds,
        foundAt: Date.now(),
      };
      // Don't set active=false — scan should resume after dispatch
      this.save(state);
    },

    // v2.10.5: once an asteroid is found in a range, the rest of that range's
    // systems are dead weight to scan (each hint range holds ~one asteroid).
    // Drop the remaining queued systems that belong to the found asteroid's
    // range(s) — BUT keep any system that ALSO falls inside a different range
    // that hasn't been satisfied yet, so heavily-overlapping ranges (e.g.
    // [310-330] / [311-331] / [317-337]) don't lose their own asteroids.
    pruneFoundRange(state, galaxy, system) {
      if (!state || !Array.isArray(state.ranges) || !Array.isArray(state.queue)) return 0;
      const inRange = (r, g, s) => r.galaxy === g && s >= r.startSystem && s <= r.endSystem;
      const allContaining = state.ranges.filter(r => inRange(r, galaxy, system));
      if (allContaining.length === 0) return 0;
      // v2.10.23: hint ranges OVERLAP (e.g. [3:28-48] and [3:39-59] share
      // 39-48). An asteroid found in the shared part belongs to only ONE of
      // them — we cannot tell which, and the other range still holds its own
      // asteroid a few systems away. Crediting the find to EVERY containing
      // range pruned them all at once, so that second asteroid was never
      // scanned and never mined.
      //
      // v2.12.9: v2.10.23's "credit the NARROWEST containing range" is not a
      // tiebreak at all when the hints are equal-width — and on athena every
      // hint row is exactly 21 systems wide, so reduce() always kept the FIRST
      // range and pruned its exclusive half unscanned. Simulation over the
      // live 10-hint layout ([3:43-63]/[3:54-74], [3:88-108]/[3:102-122],
      // [3:158-178]/[3:175-195] overlapping): only 49.3% of sweeps dispatched
      // all 10 asteroids, avg 9.37/10, and every loss was the lower range of
      // an overlapping pair. The other range's asteroid can be ANYWHERE in its
      // span — including the shared part — so an ambiguous find licenses no
      // pruning whatsoever. Extra page loads are the price of never dropping
      // an unscanned asteroid.
      if (allContaining.length > 1) {
        const labels = allContaining.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(" / ");
        log(`Asteroid [${galaxy}:${system}:17] sits in ${allContaining.length} overlapping ranges (${labels}) — can't tell which one it satisfies, keeping every system of both queued.`, "asteroid");
        return 0;
      }
      const containing = [allContaining[0]];
      const owner = allContaining[0];
      const others = state.ranges.filter(r => r !== owner);
      const before = state.queue.length;
      state.queue = state.queue.filter(q => {
        const inContaining = containing.some(r => inRange(r, q.galaxy, q.system));
        if (!inContaining) return true;                       // unrelated system → keep
        const inOther = others.some(r => inRange(r, q.galaxy, q.system));
        return inOther;                                       // shared with another range → keep; else drop
      });
      const removed = before - state.queue.length;
      if (removed > 0) {
        state.scannedCount += removed; // count skipped systems so the X/Y progress stays sane
        this.save(state);
      }
      return removed;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  DISPATCHED ASTEROIDS: Skip already-mined coordinates
  // ═══════════════════════════════════════════════════════════════

  const DispatchedAsteroids = {
    KEY: "ogamex_dispatched_asteroids",
    TTL: 60 * 60 * 1000, // fallback block when the fleet's arrival time is unknown

    _load() {
      try {
        const raw = GM_getValue(this.KEY, "[]");
        // v2.10.25: an entry expires at its releaseAt (fleet arrival + buffer)
        // when known, else after the flat TTL. The game respawns asteroids in
        // the same slots every ~5-15min, often at identical coords — a flat 1h
        // block skipped several legitimately mineable respawns per hour. Once
        // the fleet has ARRIVED the asteroid it flew to is consumed, so
        // anything visible at those coords afterwards is a NEW instance.
        return JSON.parse(raw).filter(e => Date.now() < (e.releaseAt || e.at + this.TTL));
      } catch { return []; }
    },

    add(galaxy, system) {
      const entries = this._load();
      entries.push({ coord: `${galaxy}:${system}`, at: Date.now() });
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    // v2.12.6: all live (non-expired) dispatched coords, parsed. Used by
    // buildScanQueue to drop whole ranges that already yielded an asteroid.
    coords() {
      return this._load().map(e => {
        const [g, s] = String(e.coord).split(":").map(Number);
        return { galaxy: g, system: s };
      }).filter(c => Number.isFinite(c.galaxy) && Number.isFinite(c.system));
    },

    // v2.10.25: set/tighten the expiry of the newest entry for these coords.
    // Called at send-confirmation time, when the game's own flight-time display
    // gives us the real arrival.
    release(coordStr, releaseAt) {
      if (!coordStr || !Number.isFinite(releaseAt)) return;
      const entries = this._load();
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].coord === coordStr) { entries[i].releaseAt = releaseAt; break; }
      }
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    has(galaxy, system) {
      return this._load().some(e => e.coord === `${galaxy}:${system}`);
    },

    // v2.10.27: active entries with their expiry — for the panel.
    entries() {
      return this._load().map(e => ({ coord: e.coord, freeAt: e.releaseAt || e.at + this.TTL }));
    },

    clear() {
      GM_setValue(this.KEY, "[]");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  MINING FLIGHTS (v2.39.1): how many of OUR mining flights are in the air
  // ═══════════════════════════════════════════════════════════════
  // Before v2.39.0 this was counted by subtraction: "all own missions minus
  // expeditions". The assumption that everything that is not an expedition is
  // mining is false — the owner also plays manually (colonization,
  // transports), and those missions counted toward the mining limit. Log from 11:54:
  // "flight budget reached (28/3) -> scan paused ~90min" with three real
  // asteroid flights. Mining, the main income source, stood still for an hour and a half.
  //
  // The bot sends these fleets itself, so it can count them itself. An entry lives for the ENTIRE
  // round trip there and back (DispatchedAsteroids deletes its entry already at
  // arrival, because there the point is coordinate blocking, not a fleet slot).
  // Round-trip estimate when the game does not give a flight time: 15 min (a typical flight to
  // an asteroid is 3-8 min one way). See the comment at add().
  const FALLBACK_ROUNDTRIP_MS = 15 * 60 * 1000;

  const MiningFlights = {
    KEY: "ogamex_mining_flights",

    _load() {
      try {
        const now = Date.now();
        return JSON.parse(GM_getValue(this.KEY, "[]")).filter(e => e && e.returnAt > now);
      } catch { return []; }
    },

    // flightMs = one-way flight time from the game form (may be unknown)
    // ── v2.58.0: the fallback was CATASTROPHICALLY long ──
    // When the flight time could not be read, the entry got maxFlightMinutes*2 =
    // 90 MINUTES (even more with old configs). A real flight to an asteroid
    // takes ~3-8 min, so such a ghost entry blocked a budget slot for an hour
    // or more: the log showed "flight budget reached (3/3)" with TWO real
    // missions in the game. The code's author wrote the rule himself: a "too short" mistake costs
    // at most one flight over the limit (it resolves itself), while "too long" costs
    // downtime on the main income source. So we estimate short.
    add(coord, flightMs) {
      const roundTrip = flightMs > 0
        ? flightMs * 2 + 60000
        : FALLBACK_ROUNDTRIP_MS;
      const entries = this._load();
      entries.push({ coord: coord || "?", at: Date.now(), returnAt: Date.now() + roundTrip });
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    count() { return this._load().length; },

    // ── v2.58.0: RECONCILING WITH THE GAME ──
    // The registry was the only source of truth about own flights and nobody ever
    // checked it against reality. Every entry with an inflated returnAt (unknown flight
    // time, aborted dispatch, browser restart mid-flight) hung around until expiry
    // and ate a budget slot. The game reports the number of ALL own missions ("M Own") —
    // a hard UPPER bound on the number of our mining flights (mining is a subset).
    // If we have more entries than the game sees missions, the excess are ghosts: we delete
    // the oldest, because they most likely have already returned. Returns the number removed.
    reconcile(ownMissions) {
      if (!(ownMissions >= 0)) return 0;           // no mission bar on this page
      const entries = this._load();
      if (entries.length <= ownMissions) return 0;
      entries.sort((a, b) => (a.at || 0) - (b.at || 0));   // oldest first
      const ghosts = entries.length - ownMissions;
      const kept = entries.slice(ghosts);
      GM_setValue(this.KEY, JSON.stringify(kept));
      return ghosts;
    },

    // dispatch rejected by the game → delete the last entry (the fleet never launched)
    dropLast() {
      const entries = this._load();
      entries.pop();
      GM_setValue(this.KEY, JSON.stringify(entries));
    },

    list() { return this._load(); },

    clear() { GM_setValue(this.KEY, "[]"); },
  };

  // v2.10.24: extract target coords from ANY fleet-URL shape the bot produces.
  // The same asteroid yields DIFFERENT url strings depending on how it was
  // detected (game's raw href with galaxy=/system= vs our reconstructed
  // /fleet?x=..&y=..), so every duplicate guard must compare COORDS, never
  // string-equal URLs. Returns "g:s" or null.
  function coordsFromFleetUrl(url) {
    if (!url) return null;
    const g = url.match(/[?&](?:x|galaxy)=(\d+)/);
    const s = url.match(/[?&](?:y|system)=(\d+)/);
    // v2.11.0: include the position — inactive farming targets several
    // positions in ONE system, and a 2-part coord would false-block them as
    // duplicates of each other. `planet=` is the destination TYPE, not the
    // position — never match it here.
    const z = url.match(/[?&](?:z|position)=(\d+)/);
    if (!g || !s) return null;
    return z ? `${g[1]}:${s[1]}:${z[1]}` : `${g[1]}:${s[1]}`;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TAB LOCK  (v2.10.25) — exactly ONE tab runs the bot
  // ═══════════════════════════════════════════════════════════════
  // Incident 2026-07-20: three fleets to [3:373:17] launched 1s and 14s apart.
  // A single tab physically cannot do that (one dispatch = 3 form steps with
  // sleeps ≈8-12s + navigation) → several open game tabs were EACH running the
  // scheduler and each picked up pending_mission. All GM_setValue-based guards
  // are blind to this: Tampermonkey propagates GM storage to other tabs
  // ASYNCHRONOUSLY (seconds), so the duplicate stamps raced. localStorage IS
  // synchronous across same-origin tabs — the lock lives there. The tab id
  // lives in sessionStorage so the leader keeps its identity across the many
  // page navigations the bot performs.
  const TabLock = {
    LS_KEY: "ogx_active_tab_lock",
    // 3min: background tabs get their timers throttled to ~1/min, so a
    // backgrounded leader may only refresh once a minute — 45s staleness made
    // leadership flap between tabs. A closed leader hands over within ≤3min.
    STALE_MS: 3 * 60 * 1000,
    HEARTBEAT_MS: 10 * 1000,  // independent interval keeps the lock fresh between 50-90s ticks
    _id: null,

    id() {
      if (this._id) return this._id;
      try {
        this._id = sessionStorage.getItem("ogx_tab_id");
        if (!this._id) {
          this._id = Math.random().toString(36).slice(2) + Date.now().toString(36);
          sessionStorage.setItem("ogx_tab_id", this._id);
        }
      } catch { this._id = "t" + Math.floor(Math.random() * 1e9); }
      return this._id;
    },

    _read() {
      try { return JSON.parse(localStorage.getItem(this.LS_KEY) || "null"); } catch { return null; }
    },

    // True when THIS tab holds (or successfully claims) the lock. Claiming
    // re-reads after write so a simultaneous write by another tab
    // (last-write-wins) is detected instead of both tabs believing they lead.
    isLeader() {
      const now = Date.now();
      const lock = this._read();
      if (lock && lock.id !== this.id() && now - lock.at <= this.STALE_MS) return false;
      try { localStorage.setItem(this.LS_KEY, JSON.stringify({ id: this.id(), at: now })); } catch { return true; }
      const after = this._read();
      return !after || after.id === this.id();
    },

    // v2.10.27: READ-ONLY leadership peek for UI — never claims the lock
    // (isLeader() writes, so calling it from a passive tab's status refresh
    // would steal leadership).
    peek() {
      const lock = this._read();
      if (!lock || Date.now() - lock.at > this.STALE_MS) return "unclaimed";
      return lock.id === this.id() ? "leader" : "passive";
    },
  };
  let _tabLockLogged = false;
  function requireLeader(context) {
    if (TabLock.isLeader()) return true;
    if (!_tabLockLogged) {
      _tabLockLogged = true;
      log(`PAUSED — another tab is running the bot (${context}). This tab stays passive.`, "warn");
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  //  HUMANIZER  (v2.12.0) — behavioural anti-detection
  // ═══════════════════════════════════════════════════════════════
  // A bot that acts continuously for hours with metronome regularity is
  // detectable regardless of per-action jitter. This layer adds the missing
  // macro-patterns: random full pauses ("coffee breaks") and a hard daily
  // attack cap for farming.
  const Humanizer = {
    _randMs(minMin, maxMin) { return (minMin + Math.random() * Math.max(0, maxMin - minMin)) * 60 * 1000; },

    isOnBreak() {
      const until = parseInt(GM_getValue("ogamex_break_until", "0")) || 0;
      return Date.now() < until;
    },
    breakLeftMin() {
      const until = parseInt(GM_getValue("ogamex_break_until", "0")) || 0;
      return until > Date.now() ? Math.ceil((until - Date.now()) / 60000) : 0;
    },

    // Called once per scheduler tick. Returns true when a break just started.
    // Never interrupts a dispatch in progress — the break waits for the next
    // tick with no pending mission.
    maybeStartBreak() {
      const h = CONFIG.humanizer;
      if (!h?.breaks) return false;
      const now = Date.now();
      let next = parseInt(GM_getValue("ogamex_next_break_at", "0")) || 0;
      if (!next) {
        GM_setValue("ogamex_next_break_at", String(now + this._randMs(h.breakEveryMin, h.breakEveryMax)));
        return false;
      }
      if (now < next) return false;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return false; // finish the send first
      const lenMs = this._randMs(h.breakLenMin, h.breakLenMax);
      GM_setValue("ogamex_break_until", String(now + lenMs));
      GM_setValue("ogamex_next_break_at", String(now + lenMs + this._randMs(h.breakEveryMin, h.breakEveryMax)));
      log(`Coffee break — pausing ALL bot activity for ~${Math.round(lenMs / 60000)}min (human pacing).`, "delay");
      return true;
    },

    attacksToday() {
      try {
        const d = JSON.parse(GM_getValue("ogamex_attacks_today", "null"));
        const today = new Date().toISOString().slice(0, 10);
        return d?.date === today ? (d.count || 0) : 0;
      } catch { return 0; }
    },
    recordAttack() {
      const today = new Date().toISOString().slice(0, 10);
      const c = this.attacksToday() + 1;
      GM_setValue("ogamex_attacks_today", JSON.stringify({ date: today, count: c }));
      return c;
    },
    attackLimitReached() {
      const lim = CONFIG.humanizer?.maxAttacksPerDay || 0;
      return lim > 0 && this.attacksToday() >= lim;
    },
  };

  // v2.10.25: the last-sent duplicate stamp lives in BOTH GM storage (survives
  // browser restart, per-universe prefixed) and localStorage (synchronous
  // across tabs — GM propagates async between tabs, which is how the stamps
  // raced). Read = newest of the two; write = both.
  function readLastSent() {
    let a = null, b = null;
    try { a = JSON.parse(GM_getValue("ogamex_last_sent_target", "null")); } catch {}
    try { b = JSON.parse(localStorage.getItem("ogx_last_sent_target") || "null"); } catch {}
    if (a && b) return (a.at || 0) >= (b.at || 0) ? a : b;
    return a || b;
  }
  function writeLastSent(v) {
    const s = v ? JSON.stringify(v) : "null";
    GM_setValue("ogamex_last_sent_target", s);
    try {
      if (v) localStorage.setItem("ogx_last_sent_target", s);
      else localStorage.removeItem("ogx_last_sent_target");
    } catch {}
  }

  // v2.10.25: server-truth duplicate check — storage guards are blind across
  // browsers/machines and race across tabs; the game's own event list is the
  // ground truth for "is a fleet already flying to these coords". Checks the
  // current page's embedded events first (instant), then fetches a fresh event
  // list. Fail-open: any fetch problem returns null (the storage guards still
  // apply). NOTE: return flights FROM those coords also match — conservative,
  // blocks a same-coords respawn only while a fleet is still on the books.
  async function fleetAlreadyFlyingTo(coord, { skipDom = false } = {}) {
    if (!coord) return null;
    // 3-part coord ("g:s:z", v2.11.0) is used verbatim; legacy 2-part coords
    // came only from asteroid URLs, whose position is always 17.
    const needle = coord.split(":").length === 3 ? `[${coord}]` : `[${coord}:17]`;
    // skipDom: at fleet-form step 3 the page may render the CHOSEN target as
    // text — matching our own about-to-be-sent target would block every send.
    // The pre-click recheck therefore uses only the fresh server fetch.
    if (!skipDom) try {
      // MUST exclude the bot's own panel: the persisted log contains lines
      // like "ASTEROID at [3:373:17]!" — matching them would block every send.
      const pageText = Array.from(document.body.children)
        .filter(el => el.id !== "ogx-bot-panel")
        .map(el => el.textContent || "")
        .join(" ");
      if (pageText.includes(needle)) return "page-events";
    } catch {}
    // v2.59.0: the first in line is the CONFIRMED endpoint of this server
    // (the fleet movement list gives each mission's target as [g:s:p] in the row content).
    // The old /ajax/* from upstream OGameX don't exist here (404) — the 2.54.0 cleanup
    // missed this spot and every mining dispatch left two 404s in the server
    // logs. The Ajax.supported gate disables the dead address after the first 404.
    for (const url of ["/home/fleetmovementlist", "/ajax/fleet/eventlist", "/ajax/fleet/eventbox"]) {
      if (!Ajax.supported(url)) continue;
      try {
        const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) { Ajax.markUnsupported(url, res.status); continue; }
        Ajax.markWorking(url);
        const txt = await res.text();
        if (txt.includes(needle)) return url;
      } catch {}
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  ASTEROID YIELD TRACKER  (v2.10.0)
  // ═══════════════════════════════════════════════════════════════
  // Decides how many miners a single mission needs, instead of always
  // sending 100%. Two learned inputs:
  //
  //   • cargoPerMiner  — capacity of ONE asteroid miner. Learned from the
  //                      fleet confirmation page (total cargo shown there ÷
  //                      miners selected). Overridable via config.cargoPerMiner.
  //   • expectedResources — typical resources on an asteroid. Learned from the
  //                      "resources found" mission reports (AsteroidYieldTracker
  //                      .recordYield). We size against a high percentile of the
  //                      sample window so above-average asteroids aren't
  //                      under-served. Overridable via config.expectedResourcesPerAsteroid.
  //
  //   minersNeeded = clamp(ceil(expectedResources / cargoPerMiner × buffer),
  //                        minMinersPerMission, ∞)
  //
  // If either input is unknown we return CONFIG.minersPerMission (0 = all),
  // i.e. exactly the legacy behaviour until enough has been learned.
  const AsteroidYieldTracker = {
    SAMPLES_KEY: "ogamex_yield_samples",   // [{res, at}] resources-found reports
    CARGO_KEY: "ogamex_cargo_per_miner",   // learned cargo capacity of one miner
    SEEN_REPORTS_KEY: "ogamex_seen_reports", // dedupe report ids already counted

    _loadSamples() {
      try { return JSON.parse(GM_getValue(this.SAMPLES_KEY, "[]")); } catch { return []; }
    },

    // Record one "resources found" mission yield (sum of metal+crystal+deut).
    recordYield(resources) {
      if (!Number.isFinite(resources) || resources <= 0) return;
      const max = CONFIG.asteroidMining.yieldSampleSize || 20;
      const samples = this._loadSamples();
      samples.push({ res: Math.round(resources), at: Date.now() });
      while (samples.length > max) samples.shift();
      GM_setValue(this.SAMPLES_KEY, JSON.stringify(samples));
      log(`Yield sample recorded: ${Math.round(resources).toLocaleString()} (n=${samples.length}, est now ${this.expectedResources().toLocaleString()})`, "asteroid");
    },

    // Learn cargo-per-miner from the fleet confirmation page.
    recordCargoPerMiner(totalCargo, minersSelected) {
      if (!Number.isFinite(totalCargo) || totalCargo <= 0) return;
      if (!Number.isFinite(minersSelected) || minersSelected <= 0) return;
      const per = Math.round(totalCargo / minersSelected);
      if (per <= 0) return;
      // ── v2.63.2: sanity guard ──
      // 2026-08-03 18:08:20 the step-2 parser caught the NUMBER OF LIGHT
      // CARGO SHIPS (4 777 288 823 — digit for digit the hangar count) instead of
      // cargo capacity and "learned" 4 instead of 20 750. For 28 s minersNeeded
      // was computed from a value 5000× too small. A miner's physical cargo capacity
      // changes only with research — never in order-of-magnitude jumps.
      // A new value deviating >3× from the known one is a garbage reading, not knowledge.
      const prev = parseInt(GM_getValue(this.CARGO_KEY, "0")) || 0;
      if (prev > 0 && (per > prev * 3 || per < prev / 3)) {
        log(`Rejecting cargo reading ${per.toLocaleString()}/miner (known: ${prev.toLocaleString()}) — the parser caught the wrong number from the page.`, "warn");
        return;
      }
      GM_setValue(this.CARGO_KEY, String(per));
      log(`Learned cargo/miner: ${per.toLocaleString()} (total ${totalCargo.toLocaleString()} ÷ ${minersSelected} miners)`, "fleet");
    },

    cargoPerMiner() {
      const cfg = CONFIG.asteroidMining.cargoPerMiner || 0;
      if (cfg > 0) return cfg;
      // v2.54.0: check-target doesn't exist on this server (404), so the only
      // source left is the value learned from reports — and it matches: the log
      // repeatedly confirmed 20 750 per miner.
      return parseInt(GM_getValue(this.CARGO_KEY, "0")) || 0;
    },

    // High-percentile of the rolling sample window (fallback to config seed).
    expectedResources() {
      const cfg = CONFIG.asteroidMining.expectedResourcesPerAsteroid || 0;
      const samples = this._loadSamples().map(s => s.res).filter(n => n > 0).sort((a, b) => a - b);
      if (samples.length === 0) return cfg; // nothing learned yet → seed (or 0)
      const p = Math.min(100, Math.max(1, CONFIG.asteroidMining.estimatePercentile || 85));
      const idx = Math.min(samples.length - 1, Math.floor((p / 100) * samples.length));
      const learned = samples[idx];
      return Math.max(learned, cfg); // never below an explicit manual seed
    },

    // How many miners to send on ONE flight. 0 = send all available.
    // Priority:
    //   1. Explicit "miners per flight" (minersPerMission > 0) — manual control wins.
    //   2. Auto right-sizing from cargo + expected resources (if both known).
    //   3. 0 → send all (until anything is configured/learned).
    minersNeeded() {
      const am = CONFIG.asteroidMining;
      if ((am.minersPerMission || 0) > 0) return am.minersPerMission; // explicit per-flight cap wins
      const cargo = this.cargoPerMiner();
      const est = this.expectedResources();
      if (cargo > 0 && est > 0) {
        const buf = am.bufferFactor || 1.15;
        const n = Math.ceil((est / cargo) * buf);
        return Math.max(am.minMinersPerMission || 1, n);
      }
      return 0; // send all
    },

    // ── Engine A: parse asteroid mining reports to learn expectedResources ──
    // ⚠️ SELECTORS UNVERIFIED on live OGameX. This runs only on message-like
    // pages, is fully wrapped in try/catch, and never throws into the main
    // flow. When it sees candidate report markup it dumps the raw HTML to the
    // log so the exact selectors can be confirmed, then tightened. Until
    // verified, set config.expectedResourcesPerAsteroid manually to enable
    // right-sizing immediately.
    // v2.10.27: `root` lets the same parser run on the live page (default) or
    // on a fetched-and-DOMParsed messages document (fetchReportsPeriodic).
    scanReports(root = document, sourceLabel = "page") {
      if (!CONFIG.asteroidMining.learnFromReports) return;
      try {
        if (root === document) {
          const path = location.pathname.toLowerCase();
          const looksLikeMessages = /message|communication|report|nachricht|wiadomo/.test(path) ||
            /Asteroid\s*Mining/i.test(document.body.textContent || "");
          if (!looksLikeMessages) return;
        }

        // Candidate report containers — try a few common message selectors.
        let containers = Array.from(root.querySelectorAll(
          ".message, .msg, .messageContent, [data-message-id], .message_item, li.message, .communication-item"
        ));
        // v2.19.0: class names differ per OGameX build and guessing them is
        // what left this parser blind. Fall back to structure-agnostic
        // scanning: the INNERMOST elements that mention an asteroid are the
        // report bodies, whatever they happen to be wrapped in. Extraction
        // below is text-based anyway, so a container only has to be small and
        // not contain another report.
        if (containers.length === 0) {
          // A report body is the smallest element holding BOTH the asteroid
          // keyword and an outcome (resources, dark matter or "empty"). Keying
          // on "asteroid" alone picks the heading span, which carries no
          // numbers — so require both, then take the innermost such element.
          const isReport = (t) =>
            /asteroid/i.test(t) &&
            /(metal|crystal|kristall|kryszta|deuterium|deuter|dark\s*matter|ciemna\s*materia|empty|nothing found|nichts|pusto|brak)/i.test(t);
          containers = Array.from(root.querySelectorAll("*")).filter(el => {
            const t = el.textContent || "";
            if (!t || t.length > 3000 || !isReport(t)) return false;
            return !Array.from(el.children).some(ch => isReport(ch.textContent || ""));
          });
          if (containers.length) {
            // v2.49.1: this line fired on EVERY visit to any page and flooded
            // the log. The content doesn't change, so once every 10 minutes
            // is enough to know that the page engine still doesn't understand
            // this server's markup.
            {
              const k = "ogamex_yield_unknown_logged_at";
              const lastNote = parseInt(GM_getValue(k, "0")) || 0;
              if (Date.now() - lastNote > 10 * 60 * 1000) {
                GM_setValue(k, String(Date.now()));
                log(`Yield fetch (${sourceLabel}): unknown message markup — generic block scan found ${containers.length} candidate(s).`, "info");
              }
            }
          }
        }
        if (containers.length === 0) {
          if (root !== document) {
            log(`Yield fetch (${sourceLabel}): no known message markup — selectors need tuning for this OGameX build.`, "warn");
            // v2.16.1: stop repeating that warning forever and DUMP the page
            // instead. Without report parsing the bot is blind to what
            // expeditions and asteroids actually bring back — which is exactly
            // the number needed to decide whether bigger waves still pay off.
            // Same one-shot trick that gave us the expedition link (mission=1,
            // not the 15 everyone would assume).
            if (GM_getValue("ogamex_messages_markup_dumped_v219", "") !== "1") {
              GM_setValue("ogamex_messages_markup_dumped_v219", "1");
              const html = (root.body?.innerHTML || root.documentElement?.innerHTML || "")
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/\s+/g, " ")
                .trim();
              log(`[MSG DOM] ${sourceLabel} (${html.length}ch): ${html.slice(0, 1800)}`, "info");
            }
          }
          return;
        }

        const seen = new Set(JSON.parse(GM_getValue(this.SEEN_REPORTS_KEY, "[]")));
        let learned = 0, dumped = 0, capped = 0;

        containers.forEach((c, i) => {
          const text = (c.textContent || "").replace(/\s+/g, " ").trim();
          if (!/asteroid/i.test(text)) return; // only asteroid mining reports

          // Stable-ish id for dedupe: explicit id attr, else a hash of the text.
          const id = c.getAttribute("data-message-id") || c.id ||
            ("h" + Math.abs([...text].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)));
          if (seen.has(id)) return;

          // Outcome detection. Empty / dark matter / container ⇒ 0 resources,
          // but still mark seen so we don't reprocess. Resources ⇒ sum them.
          const isEmpty = /(empty|nothing found|nichts|pusto|brak)/i.test(text);
          const isDM = /dark\s*matter|dunkle\s*materie|ciemna\s*materia/i.test(text);
          let resources = 0;
          if (!isEmpty && !isDM) {
            // ── v2.23.0: read the heading, not the word "Metal" ──
            // This build labels every amount with an ICON, so the only words in
            // the report are the headings: "Resources found", "Fuel
            // consumption", "Total profit (Metal)". The label regex below
            // therefore matched exactly one thing — the "Metal" inside "Total
            // profit" — and learned profit-AFTER-FUEL as the asteroid's
            // content (4 084 467 657 139 instead of 4 150 000 000 000 on the
            // owner's report). Anchor on the heading and sum what follows it.
            const nums = [];
            const seg = text.match(/resources?\s*found([\s\S]{0,120}?)(?:fuel\s*consumption|total\s*profit|mission\s*date|$)/i);
            if (seg && seg[1]) {
              // No \s in the class: "4.150.000.000.000 0" is TWO amounts
              // (metal and crystal), and letting a space join them produced
              // 41 500 000 000 000 — a tenfold over-estimate from one stray zero.
              for (const g of seg[1].match(/\d[\d.,]*/g) || []) {
                const v = parseInt(g.replace(/[^\d]/g, ""), 10);
                if (Number.isFinite(v) && v > 0) nums.push(v);
              }
            }
            // Fallback for builds that DO write the resource names out.
            if (nums.length === 0) {
              const re = /(?:metal|crystal|kristall|kryszta|deuterium|deuter)\D{0,12}?([\d.,\s]{2,})/gi;
              let m;
              while ((m = re.exec(text)) !== null) {
                const v = parseInt((m[1] || "").replace(/[^\d]/g, ""), 10);
                if (Number.isFinite(v) && v > 0) nums.push(v);
              }
            }
            resources = nums.reduce((a, b) => a + b, 0);

            // ── The haul is capped by the fleet's TOTAL cargo ──
            // When "resources found" equals the capacity of the miners that
            // flew, the number is a FLOOR, not the asteroid's content: the
            // rest stayed in the ground. Learning it as "expected" is how a
            // small fleet teaches itself to stay small. Flag it loudly; the
            // sample is kept but marked, so the estimate can't be trusted as
            // an upper bound.
            const minersM = text.match(/asteroid\s*miner\D{0,12}?([\d][\d.,\s]*)/i);
            const minersSent = minersM ? parseInt(minersM[1].replace(/[^\d]/g, ""), 10) : 0;
            const cargo = this.cargoPerMiner();
            if (resources > 0 && minersSent > 0 && cargo > 0) {
              const capacity = minersSent * cargo;
              if (resources >= capacity * 0.98) {
                capped++;
                log(`[YIELD] cargo limit: ${minersSent.toLocaleString()} miners carried ${resources.toLocaleString()} = full cargo capacity ${capacity.toLocaleString()}. The asteroid had MORE — the rest stayed in the ground.`, "warn");
              }
            }
            // Diagnostics: if it's clearly an asteroid resources report but we
            // parsed nothing, dump it so selectors/regex can be fixed.
            if (resources === 0 && dumped < 3) {
              log(`[REPORT?] asteroid report, 0 parsed — verify markup: ${text.substring(0, 240)}`, "warn");
              dumped++;
            }
          }

          seen.add(id);
          if (resources > 0) { this.recordYield(resources); learned++; }
        });

        if (learned > 0 || seen.size) {
          GM_setValue(this.SEEN_REPORTS_KEY, JSON.stringify([...seen].slice(-300)));
        }
        if (learned > 0) log(`Parsed ${learned} new asteroid report(s) for yield learning (${sourceLabel})${capped ? ` — ${capped} of them hit the cargo limit, so the asteroid estimate is understated` : ""}`, "asteroid");
      } catch (err) {
        log(`Report scan error (non-fatal): ${err.message}`, "warn");
      }
    },

    // ── Engine B (v2.10.27): FETCH the messages page periodically ──
    // Root cause of "est: ?": Engine A only parses reports when the browser is
    // ON a messages page — and the bot never navigates there, so it never
    // learned anything. Leader-only (called from the gated scheduler tick),
    // every 30min, fail-open. Endpoint guessed from OGameX's route shape; the
    // no-markup warning above tells us if the selectors/URL need tuning.
    FETCH_EVERY_MS: 30 * 60 * 1000,
    async fetchReportsPeriodic() {
      if (!CONFIG.asteroidMining.learnFromReports) return;
      const last = parseInt(GM_getValue("ogamex_yield_fetch_at", "0")) || 0;
      if (Date.now() - last < this.FETCH_EVERY_MS) return;
      GM_setValue("ogamex_yield_fetch_at", String(Date.now()));
      // v2.41.0: the proper endpoint of the messages tab (MessagesController@
      // ajaxGetTabContents): /ajax/messages?tab=fleets&pagination=1. Expedition
      // and mining-run reports live in the "fleets" tab; previously the bot
      // fetched bare /messages and landed on "unknown message markup".
      // ── v2.49.0: the proper report URLs, caught by ApiSniffer ──
      // This server is a .NET app with its own message API. The game itself
      // queries them when opening tabs:
      //   /messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1
      //   /messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1
      // FLEET_OTHER carries mining-run reports ("Resources found"),
      // FLEET_EXPEDITION — expedition loot. Until now the bot fetched bare
      // /messages and ended up on "unknown message markup", so the miner's
      // cargo capacity and expected yield were learned only from random
      // visits to the messages page. Additionally /home/Partial_AsteroidJournal
      // is a ready-made expedition journal — if it responds, it's the best source.
      for (const url of [
        "/home/Partial_AsteroidJournal",
        "/messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1",
        "/messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1",
        "/messages",
      ]) {
        if (!Ajax.supported(url)) continue;
        try {
          const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (!res.ok) { Ajax.markUnsupported(url, res.status); continue; }
          const html = await res.text();
          if (res.redirected || /login|password/i.test(html.substring(0, 500))) continue; // session page, not messages
          // v2.64.0: before the old parsers start guessing — if a key exists,
          // the model reads the HTML directly. LLM failure = silent continuation the old way.
          try {
            const n = await LlmParser.extractYields(html, url);
            if (n > 0) return;
          } catch {}
          // v2.49.0: dump a sample the first time from each source — without it,
          // a parser can't be written for THIS server's markup, and guessing once
          // already cost five versions.
          // v2.63.3: key bumped — the dump from 2 August was lost from the log, and
          // without the expedition journal markup, a yield parser can't be written.
          const dumpKey = `ogamex_dump2_${url.replace(/\W+/g, "_").slice(0, 60)}`;
          if (GM_getValue(dumpKey, "") !== "1") {
            GM_setValue(dumpKey, "1");
            log(`[REPORTS] ${url} → ${html.length} ch: ${html.replace(/\s+/g, " ").slice(0, 1200)}`, "info");
          }
          const doc = new DOMParser().parseFromString(html, "text/html");
          this.scanReports(doc, url);
          return; // the first source that responded is enough
        } catch {}
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET DISPATCHER: Navigate fleet send pages
  // ═══════════════════════════════════════════════════════════════

  const FleetDispatcher = {
    // Navigate to fleet page for a specific planet
    async goToFleet(planet) {
      // OGameX fleet URL format: /fleet?x=galaxy&y=system&z=position
      // (confirmed from galaxy view: /fleet?x=6&y=476&z=16&mission=1)
      const url = `/fleet?x=${planet.galaxy}&y=${planet.system}&z=${planet.position}`;
      log(`Navigating to fleet: ${planet.name} [${planet.galaxy}:${planet.system}:${planet.position}]`);
      window.location.replace(url);
      // Page will reload — pending_mission flow handles next steps
    },

    // Step 1: Select ships on fleet page and click Next
    async selectShipsAndNext(shipType, quantity) {
      if (GameState.getCurrentPage() !== "fleet") {
        log("Not on fleet page, cannot select ships", "error");
        return false;
      }

      // Find the ship input
      const shipItems = document.querySelectorAll(".ship-item, [data-ship-type]");
      for (const item of shipItems) {
        if (item.dataset?.shipType === shipType) {
          const input = item.querySelector('input[type="text"], input.numberFormatInput');
          if (input) {
            const available = parseInt(item.dataset?.shipQuantity || "0");
            const toSend = quantity === 0 ? available : Math.min(quantity, available);
            input.value = toSend;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            log(`Selected ${toSend} ${shipType}`, "fleet");

            await AntiDetection.shortDelay();

            // Click Next button
            const nextBtn = document.querySelector('a.next, button.next, [class*="next"]');
            if (nextBtn) {
              nextBtn.click();
              return true;
            }
          }
        }
      }

      log(`Could not find ship ${shipType} on fleet page`, "error");
      return false;
    },

    // Step 2: Set coordinates and click Next
    async setTargetAndNext(galaxy, system, position) {
      await AntiDetection.shortDelay();

      // Set coordinate fields
      const galaxyInput = document.querySelector('input[name="galaxy"], input#galaxy');
      const systemInput = document.querySelector('input[name="system"], input#system');
      const positionInput = document.querySelector('input[name="position"], input#position');

      if (!galaxyInput || !systemInput || !positionInput) {
        // Try alternative selectors
        const inputs = document.querySelectorAll('.coords input, input[type="text"]');
        if (inputs.length >= 3) {
          inputs[0].value = galaxy;
          inputs[1].value = system;
          inputs[2].value = position;
        } else {
          log("Cannot find coordinate inputs", "error");
          return false;
        }
      } else {
        galaxyInput.value = galaxy;
        systemInput.value = system;
        positionInput.value = position;
      }

      // Trigger change events
      document.querySelectorAll('input').forEach(i => i.dispatchEvent(new Event("change", { bubbles: true })));

      log(`Set target: [${galaxy}:${system}:${position}]`, "fleet");

      await AntiDetection.shortDelay();

      // Click Next
      const nextBtn = document.querySelector('a.next, button.next, [class*="next"], input[value="Next"]');
      if (nextBtn) {
        nextBtn.click();
        return true;
      }

      log("Cannot find Next button on target page", "error");
      return false;
    },

    // Step 3: Select mission and send fleet
    async selectMissionAndSend(missionId) {
      await AntiDetection.shortDelay();

      // Try clicking mission icon/button
      const missionBtns = document.querySelectorAll('[data-mission], .mission-select a, [class*="mission"]');
      for (const btn of missionBtns) {
        if (btn.dataset?.mission === String(missionId) || btn.href?.includes(`mission=${missionId}`)) {
          btn.click();
          log(`Selected mission type ${missionId}`, "fleet");
          break;
        }
      }

      await AntiDetection.shortDelay();

      // Click Send Fleet button
      const sendBtn = document.querySelector('a.send, button.send, [class*="send-fleet"], input[value*="Send"]');
      if (sendBtn) {
        sendBtn.click();
        log("Fleet sent!", "fleet");
        return true;
      }

      // Try finding by text content
      const allBtns = document.querySelectorAll("a, button, input[type='submit']");
      for (const btn of allBtns) {
        if (btn.textContent?.includes("Send fleet") || btn.value?.includes("Send fleet")) {
          btn.click();
          log("Fleet sent!", "fleet");
          return true;
        }
      }

      log("Cannot find Send Fleet button", "error");
      return false;
    },
  };

  // v2.12.4: every "queue exhausted" exit must land in a cooldown. Several
  // exits used to just clear ScanState, letting the very next tick start a
  // brand-new scan of the SAME still-advertised range — observed live:
  // dispatch to the only asteroid of a single range emptied the queue
  // (pruneFoundRange skips the range remainder), the off-galaxy un-wedge
  // path cleared the state, and the bot re-swept [3:36-56] seconds after
  // finishing it, re-detecting the asteroid it had just dispatched to.
  // Shared quiet exit: clear + short recheck cooldown. Deliberately NO range
  // AJAX here — these exits fire right after a fleet send / dispatch failure
  // or from arbitrary pages, where an extra fetch burst is bot-tell traffic;
  // the post-cooldown startNewScan does the deep fetch anyway.
  function endSweepWithCooldown(reason) {
    ScanState.clear();
    GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + ACTIVE_RANGE_RECHECK_MIN * 60 * 1000));
    log(`${reason} — next range check in ${ACTIVE_RANGE_RECHECK_MIN}min.`, "asteroid");
  }

  // ═══════════════════════════════════════════════════════════════
  //  v2.79.0 — ALARM = EVACUATION ONLY (shared dispatch gate)
  // ═══════════════════════════════════════════════════════════════
  // Owner's rule (07.08): "when there's an attack and an alert, the bot should
  // not send fleets, only evacuate every returning fleet to a planet".
  //
  // Until now each module policed this on its own, in its own way: expeditions
  // and farming looked only at ThreatMonitor.active(), and MINING didn't look
  // AT ALL — during the 11:15-11:20 alert the scanner kept sweeping the galaxy
  // and sent 2.5 bn miners. This is the single place answering "is it allowed
  // to send anything right now".
  //
  // The defence window does NOT end the moment foreign fleets disappear from
  // the bar: a rescue or return is still in flight (81 s to the same coords),
  // the guard still sweeps the base, and resources are in the air. A wave sent
  // in this window takes ships away from evacuation and burns deuterium that
  // will be missing for the escape — exactly what was visible at 11:21:50 (an
  // expedition went out 66 s after the alert was lifted, when the moon had only the fuel reserve to its name).
  const KEY_DEFENCE_AT = "ogamex_defence_last_at";

  const DefenceHold = {
    // How long we wait after the last defence move before sending is allowed
    // again. A hop to the same coords takes ~81 s; 140 s is landing + margin
    // for the resources to make it onto the body's account.
    SETTLE_MS: 140 * 1000,

    stamp() { try { GM_setValue(KEY_DEFENCE_AT, String(Date.now())); } catch {} },

    /** Reason sending is held, or null when normal work is allowed. */
    reason() {
      try {
        if (ThreatMonitor.active()) return "alert in progress — foreign fleets en route";
        const w = MoonSave.watch() || {};
        if (w.armed) return "defence guard armed — the base must stay empty";
        const ref = parseInt(GM_getValue(KEY_DEFENCE_AT, "0")) || 0;
        const left = ref + this.SETTLE_MS - Date.now();
        if (ref && left > 0) {
          return `rescue/return still in flight (~${Math.ceil(left / 1000)}s to landing)`;
        }
      } catch {}
      return null;
    },

    /** true = sending allowed. Logs the reason no more often than every 5 min. */
    allows(who) {
      const why = this.reason();
      if (!why) return true;
      const key = `hold_${who}`;
      const last = this._said[key] || 0;
      if (Date.now() - last > 5 * 60 * 1000) {
        this._said[key] = Date.now();
        log(`[DEFENCE] ${who} held: ${why}. Evacuation takes priority.`, "warn");
      }
      return false;
    },
    _said: {},
  };

  // ── v2.79.0: escape fuel is untouchable ──
  // `deutReserve` (100 bn, owner's decision 06.08) stays on the body after
  // every rescue so that a fleet returning during an alert has fuel to escape
  // with. Nothing policed this from the other side until now: expeditions and
  // mining took fuel from the same tank, so the reserve could vanish on profit
  // runs, and at the next attack there would be nothing to evacuate with.
  // Additionally — this is the loop the owner reported 07.08 — after a rescue
  // exactly the reserve remains on the body, so every send attempt ends in the
  // game's refusal anyway; better not to enter the form at all and say so outright in the log.
  const Fuel = {
    reserve() { return Math.max(0, parseInt(CONFIG.threatAlarm?.deutReserve) || 0); },

    /** Deuterium on the currently selected body, or null when it can't be read. */
    read() {
      try {
        const el = document.querySelector(".resource-item-deuterium");
        if (!el) return null;
        // "Deuterium\n 100.000.000.000" → the first block of digits with separators.
        const m = (el.textContent || "").match(/\d[\d.,\s ']*/);
        if (!m) return null;
        const n = parseInt(m[0].replace(/[^\d]/g, ""), 10);
        return Number.isFinite(n) ? n : null;
      } catch { return null; }
    },

    /**
     * true = sending allowed. An impossible read (page without the resource
     * bar) does NOT block — the gate is meant to protect the reserve, not to
     * stop the bot on a guess.
     */
    allows(who) {
      const reserve = this.reserve();
      if (!reserve) return true;
      const have = this.read();
      if (have == null) return true;
      if (have > reserve) return true;
      const key = `fuel_${who}`;
      const last = this._said[key] || 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        this._said[key] = Date.now();
        log(`[FUEL] ${who} held: the body has ${have.toLocaleString()} deuterium, and ${reserve.toLocaleString()} is the untouchable reserve for fleet evacuation. Waiting for fuel to come back (return after the alert / production).`, "warn");
      }
      return false;
    },
    _said: {},
  };

  // ═══════════════════════════════════════════════════════════════
  //  ASTEROID MINER: Main asteroid mining logic
  // ═══════════════════════════════════════════════════════════════

  const AsteroidMiner = {
    running: false,

    // ── Main entry: called on every page load and scheduler tick ──
    async run() {
      if (!CONFIG.asteroidMining.enabled || !CONFIG.enabled) return;
      if (Humanizer.isOnBreak()) return; // v2.12.0: also covers init on-load hooks
      if (AntiDetection.isSleepTime()) {
        log("Sleep time - asteroid mining paused", "delay");
        return;
      }
      // v2.79.0: mining had NO defence gate at all — during the 07.08 alert the
      // scanner kept sweeping the galaxy and was a step away from sending 2.5 bn
      // miners. The whole machinery (scan, navigation, dispatch) stands still
      // during the evacuation: competing for the page with the rescue is as costly as the wave itself.
      if (!DefenceHold.allows("mining")) return;
      if (this.running) return;
      this.running = true;

      try {
        // ── Check if we're on galaxy page during an active scan ──
        const scanState = ScanState.load();
        if (scanState?.active && GameState.getCurrentPage() === "galaxy") {
          await this.handleGalaxyScanStep(scanState);
          return;
        }

        // ── Check if scan found an asteroid → dispatch ──
        if (scanState?.foundAsteroid) {
          await this.dispatchToFoundAsteroid(scanState);
          return;
        }

        // ── Active scan but not on galaxy page (e.g. fleet dispatch completed) ──
        // Navigate back to galaxy to continue scan, unless miners are still in flight.
        if (scanState?.active && GameState.getCurrentPage() !== "galaxy") {
          const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
          if (fleetReturnAt && Date.now() < fleetReturnAt) {
            const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
            log(`Scan paused — miners in flight (~${waitMin}min). Will resume on return.`, "delay");
            return;
          }
          // Fleet returned (or no timer) — navigate to galaxy and continue scan
          const remaining = scanState.queue || [];
          if (remaining.length > 0) {
            const next = remaining[0];
            log(`Fleet returned. Resuming scan at [${next.galaxy}:${next.system}] — ${remaining.length} systems left.`, "asteroid");
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "scan resume");
          } else {
            log("Scan complete — no systems left in queue. Starting fresh.", "asteroid");
            ScanState.clear();
          }
          return;
        }

        // ── No active scan → start new one if no scan running ──
        if (!scanState?.active) {
          // Check if miners are still in flight — wait for return before scanning
          const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
          if (fleetReturnAt && Date.now() < fleetReturnAt) {
            // Verify fleet is actually still in flight (page may show "No fleet movement")
            const noFleet = /No fleet movement/i.test(document.body.textContent);
            if (noFleet) {
              log("Timer says in flight but page shows no fleet movement. Resetting.", "asteroid");
              GM_setValue("ogamex_fleet_return_at", "0");
            } else {
              const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
              log(`Miners in flight, ~${waitMin}min until return (${new Date(fleetReturnAt).toLocaleTimeString("en-GB")})`, "delay");
              return;
            }
          }
          if (fleetReturnAt) {
            GM_setValue("ogamex_fleet_return_at", "0");
            log("Fleet returned! Starting new scan.", "asteroid");
          }
          // Check dispatch cooldown — don't rescan immediately after failed dispatch
          const lastFail = parseInt(GM_getValue("ogamex_dispatch_fail_at", "0"));
          if (lastFail && Date.now() - lastFail < 10 * 60 * 1000) {
            const waitMin = Math.ceil((10 * 60 * 1000 - (Date.now() - lastFail)) / 60000);
            log(`Dispatch cooldown: ${waitMin}min remaining (last dispatch failed)`, "delay");
            return;
          }
          if (!RateLimiter.canAct()) {
            log(`Rate limit reached. Waiting...`, "delay");
            return;
          }
          // Check nav rate limiter — don't start a scan if we'd immediately hit the cap
          const navPauseUntil = parseInt(GM_getValue("ogamex_nav_pause_until", "0"));
          if (navPauseUntil && Date.now() < navPauseUntil) {
            const waitMin = Math.ceil((navPauseUntil - Date.now()) / 60000);
            log(`Nav rate limit pause: ${waitMin}min remaining (${NavRateLimiter.count()}/${NavRateLimiter.maxPerHour} used)`, "delay");
            return;
          }
          if (navPauseUntil) GM_setValue("ogamex_nav_pause_until", "0");
          // Check scan cooldown — don't rescan immediately after full scan found nothing
          const scanCooldownUntil = parseInt(GM_getValue("ogamex_scan_cooldown_until", "0"));
          if (scanCooldownUntil && Date.now() < scanCooldownUntil) {
            // ── v2.27.0: the cooldown must not outlive its own reason ──
            // It is set when the hint pool comes back empty, and then held for
            // ten minutes no matter what. Owner's log, 22:46-22:56: hints were
            // empty at 22:46, a manual scan found FIVE ranges at 22:53:42 — and
            // the bot still answered "Scan cooldown: 3min remaining (no
            // asteroids last sweep)". Ten minutes of blindness on the biggest
            // income source, with the answer already on screen.
            // A probe is ONE ajax call, against six for a deep fetch, so
            // re-checking every 2min costs a fraction of a sweep and cuts the
            // worst case from 10 minutes to about 2.
            const lastProbe = parseInt(GM_getValue("ogamex_hint_probe_at", "0")) || 0;
            if (Date.now() - lastProbe >= HINT_PROBE_EVERY_MS) {
              GM_setValue("ogamex_hint_probe_at", String(Date.now()));
              const probe = await AsteroidScanner.scanRanges(false).catch(() => null);
              if (probe && probe.length) {
                log(`Cooldown broken: ${probe.length} hint range(s) appeared — scanning right away instead of waiting.`, "asteroid");
                GM_setValue("ogamex_scan_cooldown_until", "0");
                await this.startNewScan();
                return;
              }
            }
            const waitMin = Math.ceil((scanCooldownUntil - Date.now()) / 60000);
            log(`Scan cooldown: ${waitMin}min remaining (no asteroids last sweep)`, "delay");
            return;
          }
          if (scanCooldownUntil) GM_setValue("ogamex_scan_cooldown_until", "0");
          await this.startNewScan();
        }
      } catch (err) {
        log(`Asteroid mining error: ${err.message}`, "error");
      } finally {
        this.running = false;
        updateStatusUI();
      }
    },

    // ── Start new scan: fetch ranges → build queue → navigate to first system ──
    async startNewScan() {
      log("Starting asteroid scan...", "asteroid");
      updateStatusUI();

      // v2.9.6: Clear stale scan state UPFRONT so concurrent scheduler ticks
      // can't pick up the old state during the ~10s scanRangesFull() fetch
      // and resume the old queue mid-flight. Without this, a manual "Scan
      // Asteroids" click would start fetching new ranges, but a tick firing
      // during the fetch would see the previous scanState (still active),
      // call handleGalaxyScanStep, and continue the OLD scan from wherever
      // it was — bypassing the fresh closest-first ordering we're trying to
      // produce. Symptom: scan "starts in the middle" after a re-enable.
      ScanState.clear();

      // NOTE: Do NOT clear DispatchedAsteroids here. Its own 1h TTL handles
      // expiry. Clearing on every scan caused double-dispatch when a new scan
      // started within the window (e.g. after a quick no-asteroid scan).

      // Deep fetch — scanRangesFull() does N calls because the AJAX endpoint
      // returns a random subset per call.
      const ranges = await AsteroidScanner.scanRangesFull(6);
      GM_setValue("ogamex_last_deep_fetch_at", String(Date.now()));

      if (ranges.length === 0) {
        // v2.10.10: short cooldown instead of retrying every tick. When the
        // hint pool is genuinely empty, polling 3 AJAX calls per minute is
        // bot-tell traffic for zero gain — a 10min re-check still picks up
        // new ranges promptly.
        log(`Deep fetch returned no ranges — no asteroid hints right now. Re-check in 10min.`, "asteroid");
        GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + 10 * 60 * 1000));
        return;
      }
      log(`Collected ${ranges.length} unique ranges from deep fetch`, "asteroid");

      // v2.84.0: miners launch from launchFrom (panel) or the ACTIVE body
      const base = HomeBase.mining();
      if (!base) {
        log("Don't know the launch point (no planet bar and no minerBase) — dispatch won't start.", "warn");
      }
      const maxFlight = CONFIG.asteroidMining.maxFlightMinutes;

      // Build scan queue — all systems in all ranges, closest to base first
      const queue = AsteroidScanner.buildScanQueue(ranges, base, maxFlight);
      if (queue.length === 0) {
        const stats = AsteroidScanner.lastQueueStats || {};
        if (stats.fleetExcluded > 0 && stats.fleetExcluded === stats.totalRanges) {
          // v2.12.8: NOT an error — every hint range is claimed by a miner
          // fleet already en route. Nothing new can appear in those ranges
          // until a fleet arrives (entries release at arrival), so back off
          // like the no-hints path instead of red-flagging a healthy state.
          log(`All ${stats.totalRanges} hint range(s) already claimed by en-route miner fleets — nothing new to scan. Re-check in 10min.`, "asteroid");
          GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + 10 * 60 * 1000));
        } else {
          log("Empty scan queue — no systems in returned ranges (or all beyond maxFlight)", "error");
        }
        return;
      }

      const first = queue[0];
      const formatPreview = q => {
        if (!base || q.galaxy !== base.galaxy) return `[${q.galaxy}:${q.system}]`;
        const dist = Math.abs(q.system - base.system);
        return `[${q.galaxy}:${q.system}] (Δ${dist}, ~${AsteroidScanner.estimateFlightMinutes(dist)}min)`;
      };
      const preview = queue.slice(0, 5).map(formatPreview).join(", ");
      const baseTag = base ? `from [${base.galaxy}:${base.system}:${base.position}]` : "(no base)";
      log(
        `Scan queue: ${queue.length} systems across ${ranges.length} ranges, closest-first ${baseTag}. ` +
        `First: ${preview}`,
        "asteroid"
      );

      // Save state and navigate to first system
      ScanState.start(ranges, queue);

      log(`Navigating to galaxy [${first.galaxy}:${first.system}]...`, "asteroid");
      scanNavigate(`/galaxy?x=${first.galaxy}&y=${first.system}`, "scan start");
    },

    // ── Handle one galaxy scan step (we're on galaxy page) ──
    async handleGalaxyScanStep(scanState) {
      // Wait for DOM to fully render — galaxy rows are server-rendered, so a
      // short settle is enough (v2.10.18: trimmed from 0.9-1.7s).
      await AntiDetection.sleep(500 + Math.random() * 600);

      // Check if fleet return time is set — if miners are in flight, stop scanning
      const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
      if (fleetReturnAt && Date.now() < fleetReturnAt) {
        const noFleet = /No fleet movement/i.test(document.body.textContent);
        if (noFleet) {
          GM_setValue("ogamex_fleet_return_at", "0");
          log("Fleet returned (no fleet movement). Continuing scan.", "asteroid");
        } else {
          const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
          log(`Miners in flight (~${waitMin}min left). Scan paused — queue preserved.`, "delay");
          return;
        }
      }

      const current = scanState.queue[0];
      if (!current) {
        await this.finishSweep(scanState);
        return;
      }

      // Verify we're on the right system
      const url = window.location.href;
      const urlMatch = url.match(/[?&]y=(\d+)/);
      const currentSystem = urlMatch ? parseInt(urlMatch[1]) : -1;

      if (currentSystem !== current.system) {
        // Wrong system — navigate to correct one
        log(`Expected system ${current.system}, on ${currentSystem}. Redirecting...`, "asteroid");
        scanNavigate(`/galaxy?x=${current.galaxy}&y=${current.system}`, "wrong-system redirect");
        return;
      }

      log(`Scanning [${current.galaxy}:${current.system}]... (${scanState.scannedCount + 1}/${scanState.totalCount})`, "asteroid");
      updateStatusUI();

      // ── Per-step range verification (v2.8.8) ──
      // Empirically, a single AsteroidLocation call returns ALL active ranges
      // (deterministic snapshot — 3 consecutive calls in 4s returned identical
      // results in logs). So we do ONE cheap AJAX before every scan step:
      //   • If ranges unchanged → proceed to scan current system.
      //   • If ranges changed but current still in some range → rebuild the
      //     remainder of the queue (picks up any NEW lower/closer ranges
      //     immediately, not after 5-system delay).
      //   • If current no longer in any range → drop scannedSystems entirely
      //     and restart scan from the lowest system in the new ranges.
      // v2.10.18: throttle — re-fetching ALL ranges (an AJAX + its 2-7s
      // anti-detection sleep) on EVERY system dominated scan time for marginal
      // gain; ranges change once in many minutes, not every ~10s step. Verify
      // only every Nth system (and on the very first, scannedCount 0). A mid-scan
      // range change is caught within N systems, and the sweep-end re-fetch
      // (v2.10.13/15) covers the rest. Also anti-ban POSITIVE: ~6× fewer AJAX.
      const VERIFY_EVERY = 6;
      const freshRanges = (scanState.scannedCount % VERIFY_EVERY) === 0
        ? await AsteroidScanner.scanRanges()
        : null;
      if (freshRanges && freshRanges.length === 0) {
        log("Range verify: no active ranges — scan complete", "asteroid");
        ScanState.clear();
        return;
      }
      if (freshRanges) {
        const rangeKey = r => `${r.galaxy}:${r.startSystem}-${r.endSystem}`;
      const freshKeys = new Set(freshRanges.map(rangeKey));
      const storedKeys = new Set((scanState.ranges || []).map(rangeKey));
      const rangesChanged = freshKeys.size !== storedKeys.size
        || [...freshKeys].some(k => !storedKeys.has(k));

      if (rangesChanged) {
        const isInAnyFreshRange = (gal, sys) => freshRanges.some(r =>
          r.galaxy === gal && sys >= r.startSystem && sys <= r.endSystem
        );
        const freshLabels = freshRanges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
        const currentInAny = isInAnyFreshRange(current.galaxy, current.system);

        if (!currentInAny) {
          // Ranges shifted, current is stale — jump into the new ranges.
          // v2.12.6: KEEP the scanned-history. The old reset wiped
          // scannedSystems and rebuilt the FULL queue, so systems checked
          // minutes earlier — and even a pruned range whose asteroid already
          // had a fleet in flight — went right back into the walk (observed:
          // reset to [3:371] re-queued [3:1-41] scanned 2min before AND
          // [3:371-391] with the just-dispatched [3:385]). Filter the rebuilt
          // queue by everything this sweep already covered.
          const baseCfg = HomeBase.mining();
          const maxFlightCfg = CONFIG.asteroidMining.maxFlightMinutes;
          const scannedSetR = new Set((scanState.scannedSystems || []).map(s => `${s.galaxy}:${s.system}`));
          const fullQueue = AsteroidScanner.buildScanQueue(freshRanges, baseCfg, maxFlightCfg)
            .filter(q => !scannedSetR.has(`${q.galaxy}:${q.system}`));
          scanState.ranges = freshRanges;
          scanState.queue = fullQueue;
          scanState.totalCount = scanState.scannedCount + fullQueue.length;
          ScanState.save(scanState);

          if (fullQueue.length === 0) {
            // Everything in the fresh ranges is already covered — that's a
            // sweep end, not a fresh start (verified cooldown, no restart).
            await this.finishSweep(scanState);
            return;
          }
          const jumpTo = fullQueue[0];
          log(`Range verify: current [${current.galaxy}:${current.system}] outside new ranges ${freshLabels} — jumping to [${jumpTo.galaxy}:${jumpTo.system}] (${fullQueue.length} unscanned systems, history kept)`, "asteroid");
          scanNavigate(`/galaxy?x=${jumpTo.galaxy}&y=${jumpTo.system}`, "range-verify reset");
          return;
        }

        // Current still valid — rebuild queue so new (often closer) ranges get
        // scanned immediately after we finish this system.
        const baseCfg = HomeBase.mining();
        const maxFlightCfg = CONFIG.asteroidMining.maxFlightMinutes;
        const scannedSet = new Set((scanState.scannedSystems || []).map(s => `${s.galaxy}:${s.system}`));
        const freshQueue = AsteroidScanner.buildScanQueue(freshRanges, baseCfg, maxFlightCfg)
          .filter(q => !scannedSet.has(`${q.galaxy}:${q.system}`));
        const currentKey = `${current.galaxy}:${current.system}`;
        const rest = freshQueue.filter(q => `${q.galaxy}:${q.system}` !== currentKey);
        // v2.12.2: RANGE-COHERENT rebuild. freshQueue is distance-sorted, so a
        // rebuild used to hoist the CLOSEST range's unscanned systems to the
        // front — observed: scanning [3:181] → rebuild → jump to [3:346], and
        // earlier [3:416] → [3:336]. Ping-ponging 80+ systems in seconds is a
        // bot fingerprint (a human finishes the range they're browsing). Keep
        // the remaining systems of the CURRENT range first, then the rest in
        // their distance order.
        const curRange = freshRanges.find(r =>
          r.galaxy === current.galaxy && current.system >= r.startSystem && current.system <= r.endSystem);
        let orderedRest = rest;
        if (curRange) {
          const inCurrentRange = rest.filter(q =>
            q.galaxy === curRange.galaxy && q.system >= curRange.startSystem && q.system <= curRange.endSystem);
          const inSet = new Set(inCurrentRange.map(q => `${q.galaxy}:${q.system}`));
          orderedRest = [...inCurrentRange, ...rest.filter(q => !inSet.has(`${q.galaxy}:${q.system}`))];
        }
        scanState.ranges = freshRanges;
        scanState.queue = [current, ...orderedRest];
        scanState.totalCount = scanState.scannedCount + scanState.queue.length;
        ScanState.save(scanState);
        log(`Range verify: ranges changed to ${freshLabels} — queue rebuilt (${scanState.queue.length} systems, current [${current.galaxy}:${current.system}] kept)`, "asteroid");
        }
      }

      // Check position 17 in live DOM
      const result = AsteroidScanner.checkCurrentPageForAsteroid();

      if (result.found) {
        // Skip if already dispatched to this asteroid
        if (DispatchedAsteroids.has(current.galaxy, current.system)) {
          log(`Asteroid [${current.galaxy}:${current.system}:17] already dispatched, skipping`, "asteroid");
          ScanState.advance(scanState);
          const next = scanState.queue[0];
          if (next) {
            const scanDelay = humanScanDelayMs();
            await AntiDetection.sleep(scanDelay);
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "skip-dispatched next");
          } else {
            await this.finishSweep(scanState); // v2.12.4: sweep end → verified cooldown, not instant restart
          }
          return;
        }

        // Asteroid found!
        log(`ASTEROID at [${current.galaxy}:${current.system}:17]!`, "success");

        // v2.9.3: TTL vs flight-time check — if asteroid would vanish
        // before fleet arrives, do NOT dispatch (burns deuter on a doomed
        // mission). v2.9.5: bumped buffer 60s→300s after a real-world
        // burn where v2.9.3 estimated 7min for Δ=58 but actual was 15min.
        // 5min margin absorbs formula error + ~30s dispatch UI overhead
        // + TTL countdown elapsed during the 3-step fleet flow.
        const baseForCheck = HomeBase.mining();
        if (result.ttlSeconds != null && baseForCheck) {
          const sameGal = baseForCheck.galaxy === current.galaxy;
          const dist = sameGal ? Math.abs(baseForCheck.system - current.system) : Infinity;
          const estMin = sameGal ? AsteroidScanner.estimateFlightMinutes(dist) : Infinity;
          const estSec = estMin * 60;
          const ARRIVAL_BUFFER_SEC = 300;
          if (!Number.isFinite(estSec) || estSec + ARRIVAL_BUFFER_SEC > result.ttlSeconds) {
            // v2.98.1: an intergalactic skip gets a CLEAR message (throttle
            // 1 h) — incident 17.08: base active in g2, asteroids in g3, bot
            // kept scanning in circles and silently rejected every find with a log
            // "flight ~Infinitymin". The operator needs to know WHAT to fill in.
            if (!sameGal) {
              const lastHint = parseInt(GM_getValue("ogamex_crossgal_hint_at", "0")) || 0;
              if (Date.now() - lastHint > 3600000) {
                GM_setValue("ogamex_crossgal_hint_at", String(Date.now()));
                log(`MINING DEAD: asteroid [${current.galaxy}:${current.system}:17], but the miner launch point is [${baseForCheck.galaxy}:${baseForCheck.system}] — DIFFERENT GALAXY, every find will be rejected. In the "Miners' start (g:s:p)" panel field, enter the coordinates of a body in gal. ${current.galaxy} where miners with deuterium actually stand.`, "error");
              }
            }
            log(
              `SKIP [${current.galaxy}:${current.system}:17] — flight ~${estMin}min (${estSec}s) ` +
              `+ ${ARRIVAL_BUFFER_SEC}s buffer > TTL ${result.ttlSeconds}s. Would vanish before arrival.`,
              "warn"
            );
            // v2.9.6: Do NOT add to DispatchedAsteroids on a TTL skip. A
            // short-TTL skip means we missed THIS asteroid instance — but the
            // game spawns a fresh asteroid in the same range slot every
            // ~5-15min, often at the same coords. Blocking the system for 1h
            // means we miss N consecutive replacement asteroids with longer
            // TTLs. DispatchedAsteroids is for double-dispatch prevention on
            // an in-flight fleet; a no-op skip never sent a fleet.
            ScanState.advance(scanState);
            const next = scanState.queue[0];
            if (next) {
              await AntiDetection.sleep(humanScanDelayMs());
              scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "skip-far-asteroid next");
            } else {
              await this.finishSweep(scanState); // v2.12.4: sweep end → verified cooldown, not instant restart
            }
            return;
          }
          log(`OK to dispatch: flight ~${estMin}min (${estSec}s) < TTL ${result.ttlSeconds}s`, "asteroid");
        }

        DispatchedAsteroids.add(current.galaxy, current.system);

        if (result.fleetUrl) {
          // Direct fleet URL available — navigate to fleet page
          log(`Direct dispatch via: ${result.fleetUrl}`, "asteroid");
          // Advance scan state (don't clear) so after dispatch bot resumes from next system
          ScanState.advance(scanState);
          // v2.10.5: skip the rest of this asteroid's range — jump to the next range.
          const skipped = ScanState.pruneFoundRange(scanState, current.galaxy, current.system);
          if (skipped > 0) log(`Found asteroid in range — skipping ${skipped} remaining system(s) in it, jumping to next range.`, "asteroid");
          GM_setValue("pending_mission", JSON.stringify({
            type: "asteroid_mining_direct",
            fleetUrl: result.fleetUrl,
            shipType: "ASTEROID_MINER",
            quantity: AsteroidYieldTracker.minersNeeded(), // right-sized (0 = all, until learned)
            launchAt: HomeBase.mining(), // v2.84.0: where the fleet should launch from (the form will switch the body)
            step: "select_ships_direct",
            resumeScan: true, // flag: after dispatch, continue scanning
            timestamp: Date.now(),
          }));
          RateLimiter.record();
          await AntiDetection.shortDelay(); // 2-8s, fast like a real player clicking
          window.location.replace(result.fleetUrl);
          return;
        }

        // No direct URL — use standard dispatch
        ScanState.advance(scanState); // keep scan going after dispatch
        ScanState.pruneFoundRange(scanState, current.galaxy, current.system); // v2.10.5: skip rest of range
        ScanState.markFound(ScanState.load(), current.galaxy, current.system, result.ttlSeconds);
        await this.dispatchToFoundAsteroid(ScanState.load());
        return;
      }

      // Not found — advance to next system
      ScanState.advance(scanState);
      const next = scanState.queue[0]; // queue was shifted by advance

      if (!next) {
        // v2.12.3: THIS is where a sweep normally ends (last queued system just
        // scanned) — and until now it set a flat cooldown with NO range
        // re-fetch, logging "Ranges still active" from a snapshot up to
        // VERIFY_EVERY systems old (the old comment claimed freshRanges was
        // "guaranteed non-empty here" — false on 5 of 6 steps, where it's
        // null). The v2.10.12 sweep-end re-fetch lived only in the
        // queue-empty-at-entry branch above, which this path made unreachable:
        // net effect was brand-new hint ranges staying invisible for a full
        // cooldown (+ jitter). Funnel into the shared finishSweep instead.
        await this.finishSweep(scanState);
        return;
      }

      const target = next;

      // Navigate to next system
      const scanDelay = humanScanDelayMs();
      log(`Next: [${target.galaxy}:${target.system}] in ${Math.round(scanDelay)}ms...`, "asteroid");
      await AntiDetection.sleep(scanDelay);
      scanNavigate(`/galaxy?x=${target.galaxy}&y=${target.system}`, "next system");
    },

    // ── Sweep finished (queue exhausted) — decide what happens next ──
    // (v2.10.12, generalized in v2.12.3) OGameX rotates its asteroid hints
    // frequently: by the time one sweep ends, a brand-new set of search areas
    // is often already live. So on EVERY sweep end: deep-fetch the ranges,
    // and if anything new appeared, rescan immediately instead of cooling
    // down. Only when the re-fetch shows nothing new does the cooldown start
    // — short when hint ranges are still live (asteroids respawn in them),
    // long when the hint pool is empty. Deep fetch (not a single call) so a
    // randomly-subsetted response can't hide a fresh range; it self-limits
    // via early-exit (~3 calls when the endpoint is deterministic).
    async finishSweep(scanState) {
      const sweptKeys = new Set((scanState.ranges || []).map(r => `${r.galaxy}:${r.startSystem}-${r.endSystem}`));
      const scannedCount = scanState.scannedCount || 0;
      const freshRanges = await AsteroidScanner.scanRangesFull(6);
      const newRanges = freshRanges.filter(r => !sweptKeys.has(`${r.galaxy}:${r.startSystem}-${r.endSystem}`));
      if (newRanges.length > 0) {
        const base = HomeBase.mining();
        const maxFlight = CONFIG.asteroidMining.maxFlightMinutes;
        // v2.12.6: exclude systems the just-finished sweep already covered —
        // the fresh-range rescan is for the NEW areas, not a re-walk of the
        // ranges we finished seconds ago.
        const doneSet = new Set((scanState.scannedSystems || []).map(s => `${s.galaxy}:${s.system}`));
        const queue = AsteroidScanner.buildScanQueue(freshRanges, base, maxFlight)
          .filter(q => !doneSet.has(`${q.galaxy}:${q.system}`));
        if (queue.length > 0) {
          const newLabels = newRanges.map(r => `[${r.galaxy}:${r.startSystem}-${r.endSystem}]`).join(", ");
          log(`Sweep done (${scannedCount} systems) — ${newRanges.length} fresh range(s) appeared (${newLabels}) → rescanning now instead of a cooldown wait.`, "asteroid");
          ScanState.start(freshRanges, queue);
          const first = queue[0];
          scanNavigate(`/galaxy?x=${first.galaxy}&y=${first.system}`, "fresh-range rescan");
          return;
        }
      }
      const rangesLive = freshRanges.length > 0;
      const cooldownMin = rangesLive ? ACTIVE_RANGE_RECHECK_MIN : (CONFIG.asteroidMining.scanIntervalMin || 15);
      log(`Sweep done: ${scannedCount} systems checked, no new asteroids. ${rangesLive ? `Ranges still live (verified) → re-sweep in ${cooldownMin}min.` : `No hint ranges → waiting ${cooldownMin}min.`}`, "asteroid");
      ScanState.clear();
      // Cooldown timer so the scheduler doesn't restart immediately
      GM_setValue("ogamex_scan_cooldown_until", String(Date.now() + cooldownMin * 60 * 1000));
    },

    // ── Dispatch fleet to found asteroid ──
    async dispatchToFoundAsteroid(scanState) {
      const asteroid = scanState.foundAsteroid;
      if (!asteroid) return;
      // v2.79.0: the last gate before the dispatch itself — the miners' flight burns deuterium,
      // and the fleet-evacuation reserve is not up for grabs. The asteroid has its
      // own TTL anyway; better to lose it than the fuel for the escape.
      if (!DefenceHold.allows("mining") || !Fuel.allows("mining")) return;

      // v2.84.0: miners launch from launchFrom (panel) or the ACTIVE body
      const base = HomeBase.mining();
      if (!base) {
        log("Don't know the launch point (no planet bar and no minerBase) — not dispatching.", "error");
        ScanState.clear();
        return;
      }
      if (base.galaxy !== asteroid.galaxy) {
        log(`Launch point [${base.galaxy}:${base.system}] and asteroid ${asteroid.label} are in different galaxies — skipping.`, "error");
        ScanState.clear();
        return;
      }

      const distance = Math.abs(base.system - asteroid.system);
      const estMinutes = AsteroidScanner.estimateFlightMinutes(distance);
      if (estMinutes > CONFIG.asteroidMining.maxFlightMinutes) {
        log(`Asteroid ${asteroid.label} too far from base (~${estMinutes}min), skipping`, "asteroid");
        ScanState.clear();
        return;
      }

      // v2.9.3: TTL guard in case bot was reloaded between markFound and
      // dispatch (foundAsteroid persists in scan state across page nav).
      if (asteroid.ttlSeconds != null && asteroid.foundAt) {
        const elapsedSec = Math.floor((Date.now() - asteroid.foundAt) / 1000);
        const remainingTtl = asteroid.ttlSeconds - elapsedSec;
        const estSec = estMinutes * 60;
        if (estSec + 300 > remainingTtl) {
          log(`SKIP ${asteroid.label} — flight ~${estMinutes}min (${estSec}s) + 300s buffer > remaining TTL ${remainingTtl}s (orig ${asteroid.ttlSeconds}s, elapsed ${elapsedSec}s)`, "warn");
          // v2.9.6: skip-via-TTL does NOT add to DispatchedAsteroids — see
          // explanation in handleGalaxyScanStep's TTL guard.
          const updated = ScanState.load();
          if (updated) { updated.foundAsteroid = null; ScanState.save(updated); }
          return;
        }
      }

      log(`Dispatching to ${asteroid.label} from active body [${base.galaxy}:${base.system}:${base.position}] (~${estMinutes}min)`, "asteroid");

      // v2.10.24: this fallback path never registered the coords — the ONLY
      // dispatch initiation that didn't. In parallel mode the bot resumes
      // scanning right after the send; the asteroid stays visible in the
      // galaxy until collected, so the next sweep re-found it, has() said
      // false, and a second (and third) fleet flew to the same coords.
      if (DispatchedAsteroids.has(asteroid.galaxy, asteroid.system)) {
        log(`Asteroid [${asteroid.galaxy}:${asteroid.system}:17] already dispatched, skipping (fallback path)`, "asteroid");
        const updated2 = ScanState.load();
        if (updated2) { updated2.foundAsteroid = null; ScanState.save(updated2); }
        return;
      }
      DispatchedAsteroids.add(asteroid.galaxy, asteroid.system);

      // Use direct fleet URL with mission pre-set (same as asteroid link)
      const fleetUrl = `/fleet?x=${asteroid.galaxy}&y=${asteroid.system}&z=17&mission=12`;
      GM_setValue("pending_mission", JSON.stringify({
        type: "asteroid_mining_direct",
        fleetUrl,
        shipType: "ASTEROID_MINER",
        quantity: AsteroidYieldTracker.minersNeeded(), // right-sized (0 = all, until learned)
        launchAt: base, // v2.84.0: where the fleet should launch from (the form will switch the body)
        step: "select_ships_direct",
        resumeScan: true,
        timestamp: Date.now(),
      }));

      // Clear foundAsteroid but keep scan active for resume
      const updatedState = ScanState.load();
      if (updatedState) {
        updatedState.foundAsteroid = null;
        ScanState.save(updatedState);
      }
      RateLimiter.record();
      await AntiDetection.shortDelay(); // 2-8s, fast like a real player clicking
      window.location.replace(fleetUrl);
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  INACTIVE FARMER  (v2.11.0) — event farming of (i)/(I) players
  // ═══════════════════════════════════════════════════════════════
  // Sweeps user-configured system ranges ("3:100-200"), collects every planet
  // whose player status is (i)/(I) — skipping (v)/(p)/(b) — and attacks each
  // with Heavy Cargo via the direct fleet URL (…&z=P&planet=1&mission=8),
  // reusing the guarded select_ships_direct 3-step machinery. v2.90.0:
  // coexists with Asteroid Mining — mining has PRIORITY (asteroids
  // earn more), the farm only moves when the asteroid scanner sleeps
  // (miners in flight / cooldowns) — see farmYieldsToMining.

  // ── v2.89.0: target rank from the galaxy row ──
  // The player tooltip ("Royal Zion / Ranking: 2.881 / Write message…") is
  // server-rendered in the row's HTML — sometimes as plain text, sometimes
  // in the data-tooltip-content/title attribute (that's how the fork does tooltips in other
  // places). The parser gets a BLEND of both sources. Dot/comma/nbsp are
  // thousand separators ("2.881" = rank 2881, not 2,881).
  // ── FARM-RANK-START (test-farm-rank.js reads this block in full) ──
  const FARM_RANK_RX = /rank(?:ing)?\s*:?\s*(\d{1,3}(?:[.,  ]\d{3})+|\d+)/i;
  function farmParseRank(raw) {
    const m = FARM_RANK_RX.exec(String(raw || ""));
    if (!m) return null;
    const n = parseInt(m[1].replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function farmRankEligible(rank, maxRank) {
    if (!maxRank) return true;     // 0 = filter disabled
    if (rank == null) return true; // unknown rank → attack (fail-open), the log calls it out separately
    return rank <= maxRank;
  }
  // ── FARM-RANK-END ──

  // ── v2.90.0: MINING HAS PRIORITY, FARM FILLS THE WINDOWS ──
  // Owner's decision (14.08): asteroids earn more than farming, so
  // no more either/or (enabling the farm DISABLED mining — the bot lost
  // its main income source). Both modules can be ON at once; the farm only moves
  // ONLY when mining isn't doing anything anyway:
  //   • miners in flight (ogamex_fleet_return_at in the future — parallel mode
  //     resets that timer while it keeps scanning, so timer>now really means
  //     "the scan sleeps until the return"),
  //   • 10-min cooldown after a failed miners' dispatch,
  //   • a pause between range scans (ogamex_scan_cooldown_until).
  // In any other situation mining is working or about to start — the farm waits.
  // The rhythm from the logs: mining scans ~1-2 min, then 8-25 min of flight — the farm gets
  // most of the clock, but never at the asteroids' expense.
  // ── FARM-PRIO-START (test-farm-priorytet.js reads this block in full) ──
  const MINING_FAIL_COOLDOWN_MS = 10 * 60 * 1000; // same constant as in the asteroid scanner

  // v2.95.0: dispatch-failure stamp ONLY for mining missions. v2.66.3
  // disabled expeditions, but farm/scrap/rescue kept hitting the 10-minute
  // ASTEROID SCANNER cooldown for their own failures. Since v2.90.0 the farm runs
  // in parallel with mining, so its mishap (e.g. a form-step timeout)
  // parked mining while asteroids sat FREE — owner's observation 15.08
  // ~09:00: the farm had attacks in 4 galaxies while the scanner sat on "last dispatch failed".
  // Five flags = the same matrix that takes the flight off the miners' counter.
  function stampDispatchFailIfMining(mission) {
    const miningMission = !mission?.expedition && !mission?.farm && !mission?.recycle && !mission?.moonSave && !mission?.fleetSave;
    if (miningMission) GM_setValue("ogamex_dispatch_fail_at", String(Date.now()));
  }
  function farmYieldsToMining(s) {
    // s = { miningEnabled, now, fleetReturnAt, dispatchFailAt, scanCooldownUntil }
    if (!s.miningEnabled) return false;                                        // mining OFF → farm free
    if (s.fleetReturnAt > s.now) return false;                                 // miners in flight → farm window
    if (s.dispatchFailAt && s.now - s.dispatchFailAt < MINING_FAIL_COOLDOWN_MS) return false; // cooldown after a failure
    if (s.scanCooldownUntil > s.now) return false;                             // pause between scans
    return true;                                                               // mining working/about to start → farm yields
  }
  // ── FARM-PRIO-END ──

  // ── v2.89.0: persistent farming target database ──
  // Every scanned system OVERWRITES its own entries (a planet that stopped
  // being inactive vanishes from the database on the next visit). The database holds
  // ALL inactive players — also those beyond the rank limit — because the limit
  // can be changed with the slider without a full rescan. Entries unseen
  // for 7 days drop out on their own (a deleted planet in a system we no longer
  // visit can't keep pulling laps forever).
  const FarmTargetDB = {
    KEY: "ogamex_farm_target_db",
    TTL_DAYS: 7,
    load() {
      try { const o = JSON.parse(GM_getValue(this.KEY, "{}")); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; }
      catch { return {}; }
    },
    save(db) { GM_setValue(this.KEY, JSON.stringify(db)); },
    updateSystem(galaxy, system, entries) {
      const db = this.load();
      // v2.94.0: most systems in the sweep have no entries -
      // a before/after comparison saves writing the whole database (tens of KB) for
      // each such system. Systems with targets still save anyway (fresh seenAt).
      const before = JSON.stringify(db);
      const prefix = `${galaxy}:${system}:`;
      for (const c of Object.keys(db)) if (c.startsWith(prefix)) delete db[c];
      entries.forEach(e => { db[e.coord] = { name: e.name || "?", rank: e.rank ?? null, seenAt: Date.now() }; });
      const cut = Date.now() - this.TTL_DAYS * 86400000;
      for (const c of Object.keys(db)) if ((db[c].seenAt || 0) < cut) delete db[c];
      if (JSON.stringify(db) !== before) this.save(db);
    },
    stats(maxRank) {
      const db = this.load();
      let total = 0, eligible = 0, unknown = 0;
      for (const c in db) {
        total++;
        if (db[c].rank == null) unknown++;
        if (farmRankEligible(db[c].rank, maxRank)) eligible++;
      }
      return { total, eligible, unknown };
    },
    // Systems (within the CURRENT ranges) that hold at least one target
    // passing the filter — this is what the fast-lap queue is built from.
    eligibleSystems(maxRank, ranges) {
      const db = this.load();
      const seen = new Set(); const out = [];
      for (const c in db) {
        if (!farmRankEligible(db[c].rank, maxRank)) continue;
        const parts = c.split(":");
        const g = parseInt(parts[0]), s = parseInt(parts[1]);
        if (!Number.isFinite(g) || !Number.isFinite(s)) continue;
        if (!ranges.some(r => r.galaxy === g && s >= r.start && s <= r.end)) continue;
        const key = `${g}:${s}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ galaxy: g, system: s });
      }
      // v2.97.0: a database lap visits first the systems with the biggest
      // KNOWN loot (sum of the targets' EMA in the system); ties/unknown — numerically.
      const ysum = FarmYieldDB.systemSums();
      out.sort((a, b) => (ysum[`${b.galaxy}:${b.system}`] || 0) - (ysum[`${a.galaxy}:${a.system}`] || 0) || a.galaxy - b.galaxy || a.system - b.system);
      return out;
    },
  };

  // Per-target attack cooldown — full g:s:z coords (many targets per system).
  // ═══════════════════════════════════════════════════════════════
  //  FARM BLACKLIST (v2.96.0) — don't smash into the defense a second time
  // ═══════════════════════════════════════════════════════════════
  // Incident 15.08 (~09:30): 10 attacks in a row (30m HC each) crashed against
  // the defense of Sith Campeador's planets in [4:36-37] — inactive does NOT mean
  // defenseless, and the farm blindly returned to the same coords every lap.
  // Source of truth: combat reports. Own losses > 0 = the planet has defense
  // = ban for the TTL (defense rebuilds after a battle anyway, so a return
  // after 2 weeks only makes sense at the operator's request).
  // ── FARM-BAN-START ──
  const FarmBlacklist = {
    KEY: "ogamex_farm_blacklist",
    TTL_MS: 14 * 24 * 60 * 60 * 1000,
    load() { try { return JSON.parse(GM_getValue(this.KEY, "{}")) || {}; } catch { return {}; } },
    save(d) { GM_setValue(this.KEY, JSON.stringify(d)); },
    has(coord) {
      const e = this.load()[coord];
      return !!e && Date.now() - (e.at || 0) < this.TTL_MS;
    },
    // true = fresh ban (for counting in the log); a repeat report only refreshes the stamp
    add(coord, losses) {
      const d = this.load();
      const fresh = !d[coord];
      d[coord] = { at: Date.now(), losses: losses || 0 };
      const cut = Date.now() - this.TTL_MS;
      for (const c of Object.keys(d)) if ((d[c].at || 0) < cut) delete d[c];
      this.save(d);
      return fresh;
    },
    count() {
      const d = this.load();
      const cut = Date.now() - this.TTL_MS;
      return Object.keys(d).filter(c => (d[c].at || 0) >= cut).length;
    },
  };

  // Reads the combat-report list and bans targets the farm crashed on.
  // Same transport as the Yield fetch (a .NET API caught with a sniffer in v2.49.0);
  // the combat category is not confirmed, so: candidates + remembering
  // the working address + a parallel harvest from the OPEN /messages page
  // (harvestDom) — that second path works for sure, because it parses plain text,
  // visible on screen (name/coords/losses/loot).
  const CombatWatch = {
    KEY_AT: "ogamex_combat_watch_at",
    KEY_URL: "ogamex_combat_endpoint",
    EVERY_MS: 10 * 60 * 1000,
    CANDIDATES: [
      "/messages/messagedata?MessageCategoryType=FLEET_COMBAT&page=1",
      "/messages/messagedata?MessageCategoryType=COMBAT&page=1",
      "/messages/messagedata?MessageCategoryType=COMBAT_REPORTS&page=1",
    ],
    _num(s) { const n = parseInt(String(s).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : null; },
    // Plain text -> [{coord, losses, resources}]. Layout from the live server:
    // "Combat report: Delta 11 [4:37:11] 15.08.2026 09:36:11 MCH : 360.000.000
    //  Sith Campeador : 0 Resources : 0 Debris field : 288.000.000.000".
    // The first "name : number" pair (outside Resources/Debris) = the ATTACKER's
    // losses. A report from defending our own colony will pass too, but its
    // coordinates are OUR planet — the farm will never attack it, a wasted ban.
    parse(text) {
      const out = [];
      const marks = [];
      const re = /Combat report:[^\[]{0,80}\[(\d+):(\d+):(\d+)\]/g;
      let m;
      // Fragment starts AFTER the title — header coordinates must not fall into
      // "player : number" pairs (test: [4:37:11] gave losses "37").
      while ((m = re.exec(text))) marks.push({ start: m.index + m[0].length, idx: m.index, coord: `${m[1]}:${m[2]}:${m[3]}` });
      for (let i = 0; i < marks.length; i++) {
        let chunk = text.slice(marks[i].start, marks[i + 1] ? marks[i + 1].idx : marks[i].start + 1600);
        // The report's date and time ("15.08.2026 09:36:11") also look like
        // colon pairs — strip them before scanning.
        chunk = chunk.replace(/\d{1,2}\.\d{2}\.\d{4}[\s\u00A0]+\d{1,2}:\d{2}(:\d{2})?/g, " ");
        const resM = chunk.match(/Resources\s*:\s*([0-9][0-9.,\s\u00A0]*)/i);
        let losses = null;
        const pairRe = /([^:\n]{2,40}?)\s*:\s*([0-9][0-9.,\s\u00A0]*)/g;
        let pm;
        while ((pm = pairRe.exec(chunk))) {
          const name = pm[1].trim();
          if (/resources|debris/i.test(name)) continue;
          losses = this._num(pm[2]);
          break;
        }
        out.push({ coord: marks[i].coord, losses, resources: resM ? this._num(resM[1]) : null });
      }
      return out;
    },
    _apply(reports, sourceLabel) {
      let banned = 0;
      for (const r of reports) {
        if (r.losses == null || r.losses <= 0) continue;
        if (FarmBlacklist.add(r.coord, r.losses)) {
          banned++;
          log(`[FARM BAN] [${r.coord}] — defense smashed the fleet (losses ${r.losses.toLocaleString("en-GB")}, loot ${r.resources ?? "?"}). 14-day ban.`, "warn");
        }
      }
      if (banned) log(`[FARM BAN] ${sourceLabel}: added ${banned} planets with defense; blacklist: ${FarmBlacklist.count()}.`, "warn");
      return banned;
    },
    // Collection from the OPEN messages page — works independently of the endpoint.
    harvestDom() {
      if (!/^\/messages/.test(location.pathname)) return;
      const text = (document.body.innerText || "").replace(/\s+/g, " ");
      if (!/Combat report:/i.test(text)) return;
      this._apply(this.parse(text), "messages page");
    },
    async run() {
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < this.EVERY_MS) return;
      GM_setValue(this.KEY_AT, String(Date.now()));
      const known = GM_getValue(this.KEY_URL, "");
      for (const url of (known ? [known] : this.CANDIDATES)) {
        try {
          const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (!res.ok) continue;
          const html = await res.text();
          if (res.redirected || /login|password/i.test(html.substring(0, 500))) continue;
          const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
          if (!/Combat report:/i.test(text)) continue;
          if (!known) { GM_setValue(this.KEY_URL, url); log(`[FARM BAN] combat reports endpoint confirmed: ${url}`, "info"); }
          this._apply(this.parse(text), "reports (fetch)");
          return;
        } catch {}
      }
      if (!known && GM_getValue("ogamex_combat_probe_logged", "") !== "1") {
        GM_setValue("ogamex_combat_probe_logged", "1");
        log("[FARM BAN] no report endpoint candidate responded — bans are collected from the messages page (drop by Combat reports sometimes).", "warn");
      }
    },
  };
  // ── FARM-BAN-END ──

  // ═══════════════════════════════════════════════════════════════
  //  LOOT PRIORITY (v2.97.0) — fattest targets first
  // ═══════════════════════════════════════════════════════════════
  // Source of truth: the Plunder Journal (player profile) — exact loot per
  // attack per coordinates. Live spread 15.08: Abutre [4:372:3] 5.1 bn vs
  // Ratatosk [4:378:x] ~240 bn — a 20x difference at the same cost of
  // slot and attacks/day limit. EMA (alpha 0.5) instead of the last sample,
  // because loot grows with time since the previous farming.
  // ── FARM-YIELD-START ──
  const FarmYieldDB = {
    KEY: "ogamex_farm_yield",
    KEY_SEEN: "ogamex_farm_yield_seen",
    TTL_MS: 30 * 24 * 60 * 60 * 1000,
    load() { try { return JSON.parse(GM_getValue(this.KEY, "{}")) || {}; } catch { return {}; } },
    save(d) { GM_setValue(this.KEY, JSON.stringify(d)); },
    avg(coord) {
      const e = this.load()[coord];
      if (!e || Date.now() - (e.at || 0) > this.TTL_MS) return null;
      return e.p;
    },
    update(coord, profit, player) {
      if (!Number.isFinite(profit) || profit < 0) return;
      const d = this.load();
      const e = d[coord];
      d[coord] = {
        p: e ? Math.round(e.p * 0.5 + profit * 0.5) : profit,
        n: (e?.n || 0) + 1,
        at: Date.now(),
        player: player || e?.player || "?",
      };
      const cut = Date.now() - this.TTL_MS;
      for (const c of Object.keys(d)) if ((d[c].at || 0) < cut) delete d[c];
      this.save(d);
    },
    // Median of known averages — exploratory result for targets without history
    // (an unknown one may be a goldmine, so it doesn't land at the queue's end).
    median() {
      const vals = Object.values(this.load()).filter(e => Date.now() - (e.at || 0) <= this.TTL_MS).map(e => e.p).sort((a, b) => a - b);
      if (!vals.length) return null;
      return vals[Math.floor(vals.length / 2)];
    },
    // Sum of known loot per system "g:s" — the base lap's order.
    systemSums() {
      const out = {};
      const d = this.load();
      const cut = Date.now() - this.TTL_MS;
      for (const c of Object.keys(d)) {
        if ((d[c].at || 0) < cut) continue;
        const key = c.split(":").slice(0, 2).join(":");
        out[key] = (out[key] || 0) + d[c].p;
      }
      return out;
    },
    top(n) {
      return Object.entries(this.load())
        .map(([coord, e]) => ({ coord, ...e }))
        .filter(e => Date.now() - (e.at || 0) <= this.TTL_MS)
        .sort((a, b) => b.p - a.p)
        .slice(0, n);
    },
    // v2.97.3: learn in BATCHES instead of per-entry. Two bugs from live seeding
    // (19:06, three times "638 entries" with the same base): (1) the seen list
    // cap of 600 was SMALLER than one journal view (638 rows) - every added
    // entry pushed off the end exactly the one we were about to check;
    // cascade = dead dedup, everything re-learned from scratch every 15 s; (2) each
    // entry did load+save of the WHOLE database and seen list (638x per tick).
    learnBatch(rows) {
      let seen; try { seen = JSON.parse(GM_getValue(this.KEY_SEEN, "[]")) || []; } catch { seen = []; }
      const seenSet = new Set(seen);
      const d = this.load();
      let learned = 0;
      for (const r of rows) {
        if (r.profit == null || !Number.isFinite(r.profit) || r.profit < 0) continue;
        const key = `${r.coord}|${r.when}`;
        if (seenSet.has(key)) continue;
        seenSet.add(key);
        seen.unshift(key);
        const e = d[r.coord];
        d[r.coord] = {
          p: e ? Math.round(e.p * 0.5 + r.profit * 0.5) : r.profit,
          n: (e?.n || 0) + 1,
          at: Date.now(),
          player: r.player || e?.player || "?",
        };
        learned++;
      }
      if (learned) {
        const cut = Date.now() - this.TTL_MS;
        for (const c of Object.keys(d)) if ((d[c].at || 0) < cut) delete d[c];
        this.save(d);
        // cap 4000 >> the largest journal view; FIFO suffices because old
        // days don't return to the view once you leave the profile.
        GM_setValue(this.KEY_SEEN, JSON.stringify(seen.slice(0, 4000)));
      }
      return learned;
    },
  };

  // Reads the Plunder Journal: fetch of the partial (candidates — the siblings
  // Partial_AsteroidJournal and Partial_ExpeditionJournal confirmed live)
  // + collection from the OPEN profile page (works for sure: parses the
  // plain text of "date | player (i) | [g:s:p] | +loot" rows).
  const PlunderWatch = {
    KEY_AT: "ogamex_plunder_watch_at",
    EVERY_MS: 15 * 60 * 1000,
    CANDIDATES: ["/home/Partial_PlunderJournal"],
    _num(s) { const n = parseInt(String(s).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : null; },
    parse(text) {
      const out = [];
      // Amount as THOUSAND GROUPS (1-3 digits + sep+3digit blocks) — the greedy
      // class [0-9.,\s]* swallowed the space and DATE of the next row
      // ("...031 15.08.2026 18" -> 5.1e22; caught by a test before rollout).
      const re = /(\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2})[\s\u00A0]+([^\[\]()]{2,32}?)\s*\(\s*[a-zA-Z]\s*\)\s*\[(\d+):(\d+):(\d+)\][\s\u00A0]*\+[\s\u00A0]*([0-9]{1,3}(?:[.,\s\u00A0][0-9]{3})*)/g;
      let m;
      while ((m = re.exec(text))) {
        out.push({ when: m[1], player: m[2].trim(), coord: `${m[3]}:${m[4]}:${m[5]}`, profit: this._num(m[6]) });
      }
      return out;
    },
    _apply(rows, label) {
      const learned = FarmYieldDB.learnBatch(rows);
      if (learned) log(`[FARM LOOT] ${label}: learned ${learned} loot entr(ies) (base: ${Object.keys(FarmYieldDB.load()).length} targets).`, "info");
      return learned;
    },
    harvestDom() {
      const text = (document.body?.textContent || "");
      if (!/Plunder Journal/i.test(text)) return;
      this._apply(this.parse(text.replace(/\s+/g, " ")), "profile page");
    },
    async run() {
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < this.EVERY_MS) return;
      GM_setValue(this.KEY_AT, String(Date.now()));
      for (const url of this.CANDIDATES) {
        try {
          const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (!res.ok) continue;
          const html = await res.text();
          if (res.redirected || /login|password/i.test(html.substring(0, 500))) continue;
          const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
          const rows = this.parse(text);
          if (!rows.length) {
            // dump ritual: without markup we don't write a parser blind
            const dumpKey = "ogamex_plunder_dump2";
            if (GM_getValue(dumpKey, "") !== "1") {
              GM_setValue(dumpKey, "1");
              log(`[FARM LOOT] ${url} -> ${html.length} chars, 0 rows — dump: ${text.slice(0, 700)}`, "warn");
            }
            continue;
          }
          this._apply(rows, "journal (fetch)");
          return;
        } catch {}
      }
    },
  };
  // ── FARM-YIELD-END ──


  const FarmedTargets = {
    KEY: "ogamex_farmed_targets",
    _ttlMs() { return Math.max(1, CONFIG.inactiveFarming.targetCooldownMin || 180) * 60 * 1000; },
    _load() {
      try { return JSON.parse(GM_getValue(this.KEY, "[]")).filter(e => Date.now() - e.at < this._ttlMs()); }
      catch { return []; }
    },
    add(coord) {
      const es = this._load();
      es.push({ coord, at: Date.now() });
      GM_setValue(this.KEY, JSON.stringify(es));
    },
    has(coord) { return this._load().some(e => e.coord === coord); },
    count() { return this._load().length; },
    // v2.81.0: release all targets before a new lap.
    clear() {
      const n = this.count();
      GM_setValue(this.KEY, "[]");
      return n;
    },

  };

  const FarmState = {
    KEY: "ogamex_farm_scan",
    load() { try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; } },
    save(s) { GM_setValue(this.KEY, JSON.stringify(s)); },
    clear() { GM_setValue(this.KEY, "null"); },
  };

  const InactiveFarmer = {
    running: false,
    _pausedLogged: false,
    SWEEP_COOLDOWN_MIN: 15, // pause between full sweeps of the ranges

    parseRanges(str) {
      const out = [];
      String(str || "").split(",").forEach(part => {
        const m = part.trim().match(/^(\d+)\s*:\s*(\d+)\s*-\s*(\d+)$/);
        if (!m) return;
        const g = parseInt(m[1]);
        const a = Math.min(parseInt(m[2]), parseInt(m[3]));
        const b = Math.max(parseInt(m[2]), parseInt(m[3]));
        if (b - a <= 500) out.push({ galaxy: g, start: a, end: b });
      });
      return out;
    },

    cachedFleetTotal() { return parseInt(GM_getValue("ogamex_fleet_total_slots", "0")) || 0; },

    // v2.90.0: whether the farm should now yield to mining (live GM facts →
    // pure farmYieldsToMining predicate; used in run(), the on-load hook and status).
    yieldsToMining() {
      return farmYieldsToMining({
        miningEnabled: !!CONFIG.asteroidMining.enabled,
        now: Date.now(),
        fleetReturnAt: parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0,
        dispatchFailAt: parseInt(GM_getValue("ogamex_dispatch_fail_at", "0")) || 0,
        scanCooldownUntil: parseInt(GM_getValue("ogamex_scan_cooldown_until", "0")) || 0,
      });
    },

    // "Fleets: X/37" exists only on the fleet page — the total is cached from
    // visits there (init). Everywhere else the live "M Own" missions bar
    // (inflightFleetCount) tracks usage.
    slotsFree() {
      const total = this.cachedFleetTotal();
      if (!total) return 1; // unknown yet → allow one dispatch; the fleet page visit caches it
      const reserve = CONFIG.inactiveFarming.slotReserve || 0;
      return Math.max(0, total - reserve - inflightFleetCount());
    },

    async run() {
      const cfg = CONFIG.inactiveFarming;
      if (!CONFIG.enabled || !cfg.enabled) return;
      // v2.90.0: mining takes priority — the farm works only in its dead
      // windows (miners in flight / cooldowns). Farm state stays untouched,
      // so an interrupted lap resumes by itself in the next window.
      if (this.yieldsToMining()) {
        if (!this._pausedLogged) {
          this._pausedLogged = true;
          log("Farm yields: Asteroid Mining is working (priority) — I'll be back when the miners are in flight.", "delay");
        }
        return;
      }
      if (this._pausedLogged) {
        this._pausedLogged = false;
        if (CONFIG.asteroidMining.enabled) log("Farm resumes: mining is waiting for the miners to return — window for farming.", "info");
      }
      if (AntiDetection.isSleepTime()) return;
      if (Humanizer.isOnBreak()) return; // v2.12.0: also covers init on-load hooks
      // v2.15.0: attacking someone else while a fleet is inbound on US is the
      // worst possible use of a fleet slot.
      // v2.79.0: the gate covers the whole defense window (alert + guard + rescue/
      // return flight), not just the moment foreign fleets are on the bar.
      if (!DefenceHold.allows("farming")) return;
      if (Humanizer.attackLimitReached()) {
        if (!this._limitLogged) {
          this._limitLogged = true;
          log(`Farm: daily attack limit reached (${Humanizer.attacksToday()}/${CONFIG.humanizer.maxAttacksPerDay}) — resting until tomorrow (UTC).`, "warn");
        }
        return;
      }
      this._limitLogged = false;
      if (this.running) return;
      this.running = true;
      try {
        // v2.96.0: before every decision pull fresh combat reports
        // (self-throttle 10 min) — bans must precede the dispatch.
        await CombatWatch.run().catch(() => {});
        await PlunderWatch.run().catch(() => {}); // v2.97.0: loot before the decision
        const pending = GM_getValue("pending_mission", null);
        if (pending && pending !== "null") return; // a dispatch is mid-flight

        let st = FarmState.load();

        // Targets already collected → keep attacking before scanning further.
        // v2.11.2: attacks are ONLY initiated from a galaxy page (human-like:
        // player looks at the system, then attacks). Off-galaxy → go there.
        if (st?.active && st.targets?.length) {
          const pendingTargets = st.targets.filter(t => !FarmedTargets.has(t.coord));
          if (!pendingTargets.length) { st.targets = []; FarmState.save(st); return; }
          if (GameState.getCurrentPage() === "galaxy") {
            await this.dispatchNext(st);
          } else {
            const t = pendingTargets[0];
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${t.galaxy}&y=${t.system}`, "farm back-to-galaxy");
          }
          return;
        }

        if (st?.active) {
          if (GameState.getCurrentPage() === "galaxy") { await this.scanStep(st); return; }
          const next = st.queue?.[0];
          if (next) {
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "farm resume");
          } else {
            this.finishSweep(st);
          }
          return;
        }

        // No active sweep → start one (unless cooling down).
        const cool = parseInt(GM_getValue("ogamex_farm_cooldown_until", "0")) || 0;
        if (Date.now() < cool) return;
        const ranges = this.parseRanges(cfg.ranges);
        if (!ranges.length) return; // nothing configured — status line explains
        // ── v2.89.0: lap around the target base instead of a full scan ──
        // A full scan of the ranges (e.g. 998 systems of gal. 3+4 ≈ hours) refreshes
        // the target base every dbRefreshHours. BETWEEN full scans the bot cruises
        // only through systems where the base knows a target passing the rank
        // filter — the lap takes minutes, so fat targets get attacks
        // many times more often, and empty systems cost neither navigation
        // nor time. Statuses and ranks refresh on every visit
        // (scanStep overwrites the system's entries), so the base doesn't rot.
        const maxRank = cfg.maxTargetRank || 0;
        const lastFull = parseInt(GM_getValue("ogamex_farm_last_full_sweep", "0")) || 0;
        const refreshMs = Math.max(1, cfg.dbRefreshHours || 12) * 3600000;
        let queue = null, mode = "full";
        const dbFresh = Date.now() - lastFull < refreshMs;
        // v2.90.1: starting after a break (e.g. the next day) does NOT begin with
        // a full scan if the base knows targets — first ONE lap over the
        // known systems (instant loot from yesterday's knowledge), the full
        // base-refreshing scan runs right after. The flag ensures the
        // overdue lap doesn't push the full scan back indefinitely.
        const staleLapDone = GM_getValue("ogamex_farm_stale_lap_done", "0") === "1";
        // v2.98.0: sequential mode skips base laps — every run
        // is a full sweep of the ranges, system by system.
        if (cfg.sequentialSweep !== true && (dbFresh || !staleLapDone)) {
          const sys = FarmTargetDB.eligibleSystems(maxRank, ranges);
          if (sys.length) {
            queue = sys; mode = "lap";
            if (!dbFresh) {
              GM_setValue("ogamex_farm_stale_lap_done", "1");
              log("Farm: full scan overdue, but the base knows targets — lap over them first, full scan right after.", "info");
            }
          }
          // empty base within the ranges → straight to a full scan
        }
        if (!queue) {
          queue = [];
          ranges.forEach(r => { for (let s = r.start; s <= r.end; s++) queue.push({ galaxy: r.galaxy, system: s }); });
        }
        // ── v2.81.0: a new lap starts with a clean slate ──
        // Owner: "ideally it would go back to previously attacked targets
        // once it's done attacking everyone in the marked range". The queue
        // visits every system exactly ONCE per run anyway, so releasing
        // blocks here can't cause a double hit in the same lap —
        // it only gives what was asked: the next lap takes everyone anew.
        // The natural pace limiter stays the sweep length plus
        // the 15-minute pause between runs.
        if (cfg.repeatEachSweep !== false) {
          const freed = FarmedTargets.clear();
          if (freed) log(`Farm: new lap — released ${freed} target(s) from the previous run (attacking again).`, "info");
        }
        st = { active: true, mode, queue, scannedCount: 0, totalCount: queue.length, targets: [], skippedRank: 0, unknownRank: 0 };
        FarmState.save(st);
        if (mode === "lap") {
          const nextFullMin = Math.max(0, Math.ceil((lastFull + refreshMs - Date.now()) / 60000));
          log(`Farm: lap AROUND THE BASE — ${queue.length} system(s) with known targets${maxRank ? ` (rank ≤ ${maxRank})` : ""}; full range scan in ~${nextFullMin} min.`, "success");
        } else {
          log(`Farm sweep started (full scan): ${queue.length} systems (${cfg.ranges})${maxRank ? ` | filter: rank ≤ ${maxRank}` : ""}`, "success");
        }
        await AntiDetection.shortDelay();
        scanNavigate(`/galaxy?x=${queue[0].galaxy}&y=${queue[0].system}`, "farm start");
      } finally {
        this.running = false;
      }
    },

    finishSweep(st) {
      // v2.89.0: the full scan is only stamped AFTER reaching the end —
      // one interrupted halfway doesn't fake a fresh base and the next
      // attempt will be full again.
      if (st?.mode !== "lap") {
        GM_setValue("ogamex_farm_last_full_sweep", String(Date.now()));
        GM_setValue("ogamex_farm_stale_lap_done", "0"); // v2.90.1: a fresh full scan clears the overdue-lap debt
      }
      const cfg = CONFIG.inactiveFarming;
      const dbStats = FarmTargetDB.stats(cfg.maxTargetRank || 0);
      const kind = st?.mode === "lap" ? "base lap" : "full scan";
      log(`Farm sweep done (${kind}): ${st?.scannedCount ?? "?"} systems checked. Target base: ${dbStats.total} inactive, ${dbStats.eligible} within limit${cfg.maxTargetRank ? ` (rank ≤ ${cfg.maxTargetRank})` : ""}${st?.skippedRank ? `, skipped ${st.skippedRank} over the limit` : ""}. Next sweep in ${this.SWEEP_COOLDOWN_MIN}min.`, "info");
      if (st?.unknownRank) log(`Farm: ${st.unknownRank} target(s) WITHOUT a read rank — the filter doesn't restrict them (attacked as before). Paste [FARM RANK DOM] from the journal for parser analysis.`, "warn");
      FarmState.clear();
      GM_setValue("ogamex_farm_cooldown_until", String(Date.now() + this.SWEEP_COOLDOWN_MIN * 60 * 1000));
    },

    async scanStep(st) {
      const cur = st.queue?.[0];
      if (!cur) { this.finishSweep(st); return; }
      // Make sure the page we're reading IS the queued system.
      const url = window.location.href;
      const gx = url.match(/[?&]x=(\d+)/);
      const sy = url.match(/[?&]y=(\d+)/);
      if (!gx || parseInt(gx[1]) !== cur.galaxy || !sy || parseInt(sy[1]) !== cur.system) {
        scanNavigate(`/galaxy?x=${cur.galaxy}&y=${cur.system}`, "farm align");
        return;
      }
      const scan = this.collectTargets(cur.galaxy, cur.system);
      const found = scan.targets;
      st.queue.shift();
      st.scannedCount++;
      st.targets = (st.targets || []).concat(found);
      st.skippedRank = (st.skippedRank || 0) + scan.skippedRank;
      st.unknownRank = (st.unknownRank || 0) + scan.unknownRank;
      FarmState.save(st);
      if (found.length) log(`Farm: ${found.length} inactive target(s) at [${cur.galaxy}:${cur.system}]: ${found.map(t => t.coord + (t.rank ? ` (rank ${t.rank})` : "")).join(", ")}`, "success");
      if (scan.skippedRank) log(`Farm: [${cur.galaxy}:${cur.system}] ${scan.skippedRank} inactive SKIPPED — rank above ${CONFIG.inactiveFarming.maxTargetRank} (empty colonies don't eat slots).`, "info");
      if (st.targets.length) { await this.dispatchNext(st); return; }
      const next = st.queue[0];
      if (next) {
        // v2.12.0 wander: occasionally detour via Overview — a human glances
        // at resources between systems. The farm state machine self-heals
        // (off-galaxy → back-to-galaxy) on the next tick, so the detour costs
        // one natural-looking browse gap. Farming only — asteroid TTLs are
        // too tight for detours.
        const wander = (CONFIG.humanizer?.wanderChance || 0) / 100;
        if (wander > 0 && Math.random() < wander) {
          log("Farm: wandering via Overview (human-like detour).", "delay");
          await AntiDetection.sleep(humanScanDelayMs());
          scanNavigate("/", "farm wander");
          return;
        }
        await AntiDetection.sleep(humanScanDelayMs());
        scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "farm next");
      } else {
        this.finishSweep(st);
      }
    },

    // Parse the CURRENT galaxy page for attackable inactive planets.
    // Status letters from the legend: s strong, n weak, v vacation,
    // p protection, b banned, i 7d-inactive, I 28d-inactive. Case matters.
    // v2.89.0: returns { targets, skippedRank, unknownRank } — targets are
    // rows passing the rank filter and not on cooldown; the target base
    // gets the FULL set of inactives for this system (system overwrite).
    collectTargets(galaxy, system) {
      const cfg = CONFIG.inactiveFarming;
      const maxRank = cfg.maxTargetRank || 0;
      const out = [];
      const dbEntries = [];
      let skippedRank = 0, unknownRank = 0, bannedSkip = 0;
      document.querySelectorAll(".galaxy-item").forEach(item => {
        const idx = item.querySelector(".planet-index");
        if (!idx) return;
        const pos = parseInt(idx.textContent.trim());
        if (!Number.isFinite(pos) || pos < 1 || pos > 15) return; // 16/17 = deep space/asteroid
        const text = (item.textContent || "").replace(/\s+/g, " ");
        const statuses = [...text.matchAll(/\(\s*([sinvpbI])\s*\)/g)].map(m => m[1]);
        const inactive = statuses.includes("i") || statuses.includes("I");
        const blocked = statuses.includes("v") || statuses.includes("p") || statuses.includes("b");
        if (!inactive || blocked) return;
        const coord = `${galaxy}:${system}:${pos}`;
        // Rank: the tooltip is sometimes row text OR an attribute — we read both.
        const attrText = [item, ...item.querySelectorAll("[data-tooltip-content],[title],[data-title]")]
          .map(el => `${el.getAttribute?.("data-tooltip-content") || ""} ${el.getAttribute?.("title") || ""} ${el.getAttribute?.("data-title") || ""}`)
          .join(" ").replace(/<[^>]*>/g, " ");
        const rank = farmParseRank(text) ?? farmParseRank(attrText);
        // Player name (for the base preview): text right before the (i)/(I) status.
        const nameM = text.match(/([^()]{2,32}?)\s*\(\s*[iI]\s*\)/);
        const name = nameM ? nameM[1].trim().slice(0, 24) : "?";
        dbEntries.push({ coord, name, rank });
        if (maxRank > 0 && rank == null) {
          unknownRank++;
          // One-time dump of a row without a read rank — to harden
          // the parser against THIS fork's markup.
          if (GM_getValue("ogamex_farm_rank_dumped", "0") !== "1") {
            GM_setValue("ogamex_farm_rank_dumped", "1");
            log(`[FARM RANK DOM] row without rank: ${item.innerHTML.replace(/\s+/g, " ").substring(0, 600)}`, "warn");
          }
        }
        if (!farmRankEligible(rank, maxRank)) { skippedRank++; return; }
        if (FarmBlacklist.has(coord)) { bannedSkip++; return; } // v2.96.0: defense = we don't go back
        if (FarmedTargets.has(coord)) return;
        // One-time DOM dump of the first matched row — verifies the status
        // parsing against this OGameX build's real markup.
        if (GM_getValue("ogamex_farm_row_dumped", "0") !== "1") {
          GM_setValue("ogamex_farm_row_dumped", "1");
          log(`[FARM DOM] first target row: ${item.innerHTML.replace(/\s+/g, " ").substring(0, 400)}`, "info");
        }
        out.push({ coord, galaxy, system, position: pos, rank });
      });
      // A fresh system scan = new truth about its base entries (planets
      // that stopped being inactive just dropped out of it).
      FarmTargetDB.updateSystem(galaxy, system, dbEntries);
      if (bannedSkip) log(`Farm: [${galaxy}:${system}] ${bannedSkip} target(s) on the blacklist (defense) — skipping.`, "info");
      return { targets: out, skippedRank, unknownRank };
    },

    async dispatchNext(st) {
      if (this.slotsFree() <= 0) {
        log(`Farm: fleet slots exhausted (reserve ${CONFIG.inactiveFarming.slotReserve}) — waiting for returns; ${st.targets?.length ?? 0} target(s) queued.`, "warn");
        return; // scheduler retries; targets persist in FarmState
      }
      let targets = (st.targets || []).filter(t => !FarmedTargets.has(t.coord) && !FarmBlacklist.has(t.coord));
      // v2.97.0: fattest targets first. Known average loot sorts descending,
      // unknown gets the MEDIAN of known ones (exploration in the middle of the
      // queue, not at the end); the minTargetProfit floor cuts KNOWN small fry (never unknown).
      const floor = CONFIG.inactiveFarming.minTargetProfit || 0;
      if (floor > 0) {
        const before = targets.length;
        targets = targets.filter(x => { const a = FarmYieldDB.avg(x.coord); return a == null || a >= floor; });
        if (before - targets.length) log(`Farm: ${before - targets.length} target(s) below the loot floor (${floor.toLocaleString("en-GB")}) — skipping.`, "info");
      }
      // v2.98.0: in sequential mode targets go in encounter order
      // (system by system) — no loot sorting.
      if (CONFIG.inactiveFarming.sequentialSweep !== true) {
        const med = FarmYieldDB.median();
        if (med != null) targets.sort((a, b) => (FarmYieldDB.avg(b.coord) ?? med) - (FarmYieldDB.avg(a.coord) ?? med));
      }
      const t = targets.shift();
      st.targets = targets;
      FarmState.save(st);
      if (!t) {
        const next = st.queue?.[0];
        if (next) {
          await AntiDetection.shortDelay();
          scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "farm continue");
        } else {
          this.finishSweep(st);
        }
        return;
      }
      FarmedTargets.add(t.coord); // stamp at initiation, same as asteroids
      const hc = Math.max(1, CONFIG.inactiveFarming.hcPerFlight || 1);
      const ship = CONFIG.inactiveFarming.shipType || "HEAVY_CARGO";
      const fleetUrl = `/fleet?x=${t.galaxy}&y=${t.system}&z=${t.position}&planet=1&mission=8`;
      log(`FARM ATTACK → [${t.coord}] with ${hc} ${ship}`, "success");
      // v2.74.8: without entered coordinates the farm launches from the currently
      // active body (the owner moves the fleet closer to the event targets).
      // v2.91.0: the "Start farming" field in the panel wins — the mission carries
      // launchAt and the v2.84 gate switches pair/body before the form, so
      // you can farm another galaxy without moving the fleet.
      const farmBase = HomeBase.farm();
      GM_setValue("pending_mission", JSON.stringify({
        type: "inactive_farm_direct",
        farm: true,
        ...(farmBase ? { launchAt: farmBase } : {}),
        fleetUrl,
        shipType: ship,
        quantity: hc,
        step: "select_ships_direct",
        resumeScan: false,
        timestamp: Date.now(),
      }));
      // v2.90.2: deliberately WITHOUT RateLimiter.record() — same pattern as
      // expeditions. The 20/h pool has one gate consumer: the asteroid scanner
      // (canAct() before scan start). Incident 14.08 11:00-11:21: 76 farm
      // attacks clogged the pool, mining stood ("Rate limit reached") with a free
      // asteroid on the plate, and the farm kept "yielding" to it — a 20+ minute
      // deadlock. Farm pace is capped by: humanizer (maxAttacksPerDay, shortDelay),
      // the galaxy→form→galaxy rhythm and the shared NavRateLimiter.
      await AntiDetection.shortDelay();
      window.location.replace(fleetUrl);
    },

    // Entry point after a farm fleet was sent (fleetSendSuccessfully / finishDispatch).
    // Shares the `running` mutex with run() — a scheduler tick firing in the
    // same window would otherwise interleave dispatchNext and drop a target.
    async afterSend() {
      if (this.running) return;
      this.running = true;
      try {
        const st = FarmState.load();
        if (!st?.active) return;
        // v2.11.2 (human-like pacing): do NOT chain fleet-form → fleet-form.
        // A real player goes back to the galaxy view of the system, hovers the
        // next planet, and only then attacks — so when more targets are
        // queued, navigate to their system's galaxy page first; the on-galaxy
        // farm hook (init + scheduler) dispatches from there after a human
        // dwell. Server-side this reads galaxy → fleet → galaxy → fleet, not
        // a burst of bare fleet-form GETs.
        const targets = (st.targets || []).filter(t => !FarmedTargets.has(t.coord) && !FarmBlacklist.has(t.coord));
        if (targets.length) {
          const t = targets[0];
          await AntiDetection.shortDelay();
          scanNavigate(`/galaxy?x=${t.galaxy}&y=${t.system}`, "farm back-to-galaxy");
          return;
        }
        await this.dispatchNext(st); // no targets left → resume sweep / finish
      } finally {
        this.running = false;
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  DEBRIS COLLECTOR (v2.48.0) — debris after expeditions
  // ═══════════════════════════════════════════════════════════════
  // An expedition can run into hostiles and lose part of the wave. What's left
  // lands as a debris field at position 16 of the base system — right where
  // the bot sends expeditions. That's our own resources sitting there to be
  // collected with recyclers; nobody else will fly in for them — it's our system.
  //
  // Three rules I stick to:
  //   • I don't guess the mission number. The galaxy row has a ready collect
  //     link — we take it whole, like with asteroids (the fork has its own
  //     numbering: expedition is mission=1, asteroid mission=12).
  //   • Recycling is NOT a mining flight. It has its own flag, so it doesn't eat
  //     the flight budget or set the scan pause.
  //   • It yields to everything: fleet rescue, an ongoing dispatch and breaks.
  // ═══════════════════════════════════════════════════════════════
  //  MOON FERRY (v2.71.0) — ferry planet → moon (moon mode)
  // ═══════════════════════════════════════════════════════════════
  // In moon mode the fleet LIVES on the moon, but the planet keeps
  // accumulating stuff: shipyard production, deuterium and mine resources —
  // and sometimes the whole fleet after an unusual episode (05.08 16:24:
  // a return after a broken flip parked everything on the planet and nothing had a basis to fix it).
  // Every 2 h the ferry ships EVERYTHING from the planet to the moon via a
  // Deploy mission — the same machinery as rescue. An empty planet = a quiet
  // end ("nothing to save"). It yields to everything: alerts, guard, ongoing
  // dispatch, breaks and the night window.
  // ═══════════════════════════════════════════════════════════════
  //  HOME BASE (v2.82.0) — launch from the CURRENT body, not a fixed base
  // ═══════════════════════════════════════════════════════════════
  // Owner's decision 12.08: aggressive neighbours force a change of the launch
  // point — mining, expeditions, debris and the ferry are to fly from the
  // planet/moon ACTIVE in the planet bar, not from the hard-coded base [3:272:7].
  // The fleet form sends from the active body anyway (confirmed live with
  // FS v2.75.0 and rescue v2.55.0) — until now the bot anchored the launch to
  // the base; now it follows the operator: switching the planet in-game = a new
  // launch point, with zero configuration.
  //   • coords() — coordinates of the active body; on pages without the planet
  //     bar the last known reading (GM cache), minerBase as a last resort.
  //   • pairMoon() — moon of the CURRENT system (the moon row renders right
  //     after its planet; STOP at the next planet so a moonless colony can't
  //     "borrow" someone else's moon).
  // Defense (rescue/guard/FS) has its own target logic — untouched.
  const HomeBase = {
    KEY: "ogamex_home_body",

    _parseCoords(el) {
      const m = (el?.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
      return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null;
    },

    _selectedEntry() {
      // Moon before planet: when a moon is selected, both entries of the pair
      // can carry the selected class — the body the form really launches
      // from wins.
      return document.querySelector(
        "a.moon-select.selected, .moon-select.selected, a.planet-select.selected, .planet-select.selected"
      );
    },

    // Live reading from the planet bar; null when the bar isn't on this page.
    read() {
      const el = this._selectedEntry();
      if (!el) return null;
      const isMoon = el.classList.contains("moon-select");
      let c = this._parseCoords(el);
      if (!c && isMoon) {
        // The moon entry often carries no coordinates — take them from the planet
        // it follows (the same adjacency as switch_to_body).
        let p = el.previousElementSibling;
        while (p && !(p.classList && p.classList.contains("planet-select"))) p = p.previousElementSibling;
        c = this._parseCoords(p);
      }
      if (!c) return null;
      const rec = { ...c, body: isMoon ? "moon" : "planet" };
      let prev = null;
      try { prev = JSON.parse(GM_getValue(this.KEY, "null")); } catch {}
      const changed = !prev || prev.galaxy !== rec.galaxy || prev.system !== rec.system
        || prev.position !== rec.position || prev.body !== rec.body;
      if (changed) {
        GM_setValue(this.KEY, JSON.stringify(rec));
        log(`[START] active body: ${rec.body === "moon" ? "moon" : "planet"} [${rec.galaxy}:${rec.system}:${rec.position}] — mining/expeditions/debris will fly from here.`, "info");
      }
      return rec;
    },

    // Coordinates of the launch point for routine dispatches. Never returns null
    // when minerBase is set — old paths may rely on it.
    coords() {
      const live = this.read();
      if (live) return live;
      try {
        const c = JSON.parse(GM_getValue(this.KEY, "null"));
        if (c && Number.isFinite(c.galaxy) && Number.isFinite(c.system)) return c;
      } catch {}
      const b = CONFIG.asteroidMining.minerBase;
      return b ? { ...b, body: null } : null;
    },

    // Moon of the pair for a given planet entry (adjacency with a STOP at the
    // next planet — a moonless pair can't "borrow" someone else's moon).
    moonOf(planetEl) {
      let n = planetEl ? planetEl.nextElementSibling : null;
      while (n && !(n.classList && n.classList.contains("moon-select"))) {
        if (n.classList && n.classList.contains("planet-select")) return null;
        n = n.nextElementSibling;
      }
      return n || null;
    },

    // Moon of the current system (planet bar element) or null when there is
    // none / it isn't visible. When a moon IS selected — returns that entry.
    pairMoon() {
      const el = this._selectedEntry();
      if (!el) return null;
      if (el.classList.contains("moon-select")) return el;
      return this.moonOf(el);
    },

    // ── v2.84.0: launch point PER MODULE ──
    // Coordinates entered in the panel win over the active body; the launch body
    // follows from the mode (baseBody moon → the moon of that pair). null/missing = as
    // before: launch from wherever the operator is.
    forModule(cfgCoords) {
      const c = cfgCoords;
      if (c && Number.isFinite(c.galaxy) && Number.isFinite(c.system) && Number.isFinite(c.position)) {
        return { galaxy: c.galaxy, system: c.system, position: c.position, body: CONFIG.baseBody === "moon" ? "moon" : "planet", fixed: true };
      }
      return this.coords();
    },
    mining() { return this.forModule(CONFIG.asteroidMining.launchFrom); },
    // v2.91.0: farm — entered coordinates win; empty = null (the mission carries no
    // launchAt and the attack launches from the active body, as since v2.74.8).
    farm() { const c = CONFIG.inactiveFarming?.launchFrom; return c ? this.forModule(c) : null; },
    // expeditions.base (old, target-only) stays in the chain as a fallback.
    expo() { return this.forModule(CONFIG.expeditions.launchFrom || CONFIG.expeditions.base); },

    // The entry of the planet with the given coordinates on the planet bar (the coordinates sit in the anchor
    // text — confirmed live by FleetRecon.activePlanet).
    pairAnchor(c) {
      if (!c) return null;
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        const m = (p.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
        if (m && +m[1] === c.galaxy && +m[2] === c.system && +m[3] === c.position) return p;
      }
      return null;
    },
  };

  const MoonFerry = {
    KEY_AT: "ogamex_ferry_at",
    EVERY_MS: 2 * 60 * 60 * 1000,

    due() {
      // v2.83.0: the ferry only on the operator's explicit request (OFF by default).
      if (!CONFIG.moonFerry?.enabled) return false;
      if (CONFIG.baseBody !== "moon" || !CONFIG.enabled) return false;
      if (ThreatMonitor.active() || MoonSave.watch().armed) return false;
      const p = GM_getValue("pending_mission", null);
      if (p && p !== "null") return false;
      if (Humanizer.isOnBreak() || AntiDetection.isSleepTime()) return false;
      return Date.now() - (parseInt(GM_getValue(this.KEY_AT, "0")) || 0) > this.EVERY_MS;
    },

    async run() {
      if (!this.due()) return false;
      // v2.82.0: the ferry handles the CURRENT pair (planet → its moon),
      // not a rigid base — otherwise every 2 h it would yank the operator out of the
      // launch spot they picked. Without the planet bar we don't know where
      // we are — no stamp, we'll try on a page that has the bar.
      const b = HomeBase.read();
      if (!b) return false;
      if (!HomeBase.pairMoon()) {
        // Colony without a moon: nowhere to haul to. Normal stamp, so we
        // don't try every tick — it will be back in 2 h or after a layout change.
        GM_setValue(this.KEY_AT, String(Date.now()));
        log("[FERRY] the current pair has no moon — ferry skipped until the launch spot changes.", "info");
        return false;
      }
      GM_setValue(this.KEY_AT, String(Date.now()));
      GM_setValue("pending_mission", JSON.stringify({
        type: "moon_ferry_direct",
        moonSave: true,       // same form handling as rescue
        ferry: true,          // …but its own entries in log/journal
        sweep: true,          // NEVER flip to the other body (v2.70.3)
        atCoords: b,
        launchBody: "planet",
        targetBody: "moon",
        homeBody: "moon",
        fleetUrl: `/fleet?x=${b.galaxy}&y=${b.system}&z=${b.position}`,
        step: "switch_to_body",
        timestamp: Date.now(),
      }));
      log("[FERRY] planet → moon: ferrying everything parked on the planet (production, resources, stray fleet). Empty planet = nothing happens.", "info");
      return true;
    },
  };

  const DebrisCollector = {
    KEY_AT: "ogamex_debris_check_at",
    KEY_SENT: "ogamex_debris_sent_at",
    KEY_DUMPED: "ogamex_debris_markup_dumped_v248",
    CHECK_EVERY_MS: 20 * 60 * 1000,   // how often we peek at the base galaxy
    RESEND_GUARD_MS: 10 * 60 * 1000,  // don't try a second time after a dispatch

    // v2.82.0: "base galaxy" = the system of the CURRENT body — expeditions fly
    // to position 16 of the current system now, so the debris they leave lies there too.
    // (Collect debris at the PREVIOUS launch spot manually, or return there with a body.)
    base() { return HomeBase.expo(); },

    // The position-16 row on the LIVE galaxy page. Returns the collect link.
    findDebrisLink() {
      // v2.70.0: besides position 16 (debris from expeditions) we also check the BASE
      // POSITION — after a defensive battle the debris lies right by the planet (05.08 morning:
      // 4.3 bn resources on [3:269:8], and the collector only looked at 16).
      const b = this.base();
      const wanted = [16, b?.position].filter(n => Number.isFinite(n));
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = parseInt(item.querySelector(".planet-index")?.textContent || "0") || 0;
        if (!wanted.includes(idx)) continue;
        const cell = item.querySelector(".col-debris, .galaxy-col.col-debris");
        // (it used to: return null on an empty cell at position 16 — that cut off the
        // base-position check; now we keep going down the list)
        if (!cell || !(cell.innerHTML || "").trim()) continue;
        if (GM_getValue(this.KEY_DUMPED, "") !== "1") {
          GM_setValue(this.KEY_DUMPED, "1");
          log(`[DEBRIS] debris field markup (pos. ${idx}): ${(cell.innerHTML || "").replace(/\s+/g, " ").slice(0, 600)}`, "info");
        }
        const a = cell.querySelector("a[href*='/fleet']");
        if (a) return a.getAttribute("href");
        // Some builds hang the collect action on an element without an <a> — we don't
        // guess the mission: markup in the log (above), we check the next row.
      }
      return null;
    },

    // How many recyclers are in the hangar (fleet page / last recon).
    recyclersHome() {
      for (const el of document.querySelectorAll("[data-ship-type='RECYCLER']")) {
        const n = parseInt(el.dataset.shipQuantity || "0") || 0;
        if (n > 0) return n;
      }
      try {
        const recon = JSON.parse(GM_getValue("ogamex_fleet_recon", "null"));
        return parseInt(recon?.ships?.RECYCLER || "0") || 0;
      } catch { return 0; }
    },

    // Called when the bot IS on the galaxy page of the base system.
    tryCollectHere() {
      if (!CONFIG.expeditions?.collectDebris) return false;
      if (GM_getValue("pending_mission", null)) return false;
      if (ThreatMonitor.active()) return false;             // rescue has priority
      const last = parseInt(GM_getValue(this.KEY_SENT, "0")) || 0;
      if (Date.now() - last < this.RESEND_GUARD_MS) return false;
      const b = this.base();
      const m = window.location.search.match(/[?&]x=(\d+)&y=(\d+)/);
      if (!m || parseInt(m[1]) !== b.galaxy || parseInt(m[2]) !== b.system) return false;
      const href = this.findDebrisLink();
      if (!href) return false;
      // v2.68.1: an empty hangar (recyclers on the moon after rescue/FS) burned
      // the 10-minute retry lock without any dispatch.
      if (this.recyclersHome() <= 0) {
        log("[DEBRIS] there is a debris field, but zero recyclers in the hangar — I'll try when they come back.", "warn");
        return false;
      }
      GM_setValue(this.KEY_SENT, String(Date.now()));
      GM_setValue("pending_mission", JSON.stringify({
        type: "debris_recycle_direct",
        recycle: true,               // NOT a mining flight
        fleetUrl: href,
        shipType: "RECYCLER",
        quantity: 0,                 // 0 = all recyclers in the hangar
        launchAt: this.base(),       // v2.84.0: recyclers live with the expedition fleet
        step: "select_ships_direct",
        resumeScan: true,
        timestamp: Date.now(),
      }));
      log(`[DEBRIS] debris field at [${b.galaxy}:${b.system}:16] — sending recyclers (${href}).`, "success");
      setTimeout(() => { window.location.replace(href); }, 800 + Math.random() * 700);
      return true;
    },

    // Periodic visit to the base galaxy. Only when the bot isn't doing anything anyway.
    // ── v2.68.1: debris was lying at 16 for hours ──
    // The visit only fired when the miners were IN FLIGHT (or once every 2 h) —
    // but with empty scans the miners sit at home and the condition never
    // held. Now the rhythm is simple: every 20 minutes, when the bot has nothing
    // more urgent; an ongoing asteroid scan lets debris survive at most 2 hours.
    shouldVisit() {
      if (!CONFIG.expeditions?.collectDebris) return false;
      if (GM_getValue("pending_mission", null)) return false;
      if (ThreatMonitor.active()) return false;
      if (Humanizer.isOnBreak() || AntiDetection.isSleepTime()) return false;
      if (this.recyclersHome() <= 0) return false; // without recyclers a visit is pointless
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < this.CHECK_EVERY_MS) return false;
      const scanActive = !!ScanState.load()?.active;
      return !scanActive || Date.now() - last > 2 * 60 * 60 * 1000;
    },

    visit() {
      const b = this.base();
      GM_setValue(this.KEY_AT, String(Date.now()));
      log(`[DEBRIS] peeking at the base galaxy [${b.galaxy}:${b.system}] for a debris field from expeditions.`, "info");
      scanNavigate(`/galaxy?x=${b.galaxy}&y=${b.system}`, "debris check");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET MOVEMENTS (v2.51.0) — who flies, why and where
  // ═══════════════════════════════════════════════════════════════
  // GET /home/fleetmovementlist — the endpoint the game itself polls to
  // refresh the mission bar. A dump from 21:09:52 showed the row carries EVERYTHING
  // the defense was missing:
  //
  //   <tr data-fleet-id="4649f6fc-…" class="row-mission-type-EXPEDITION">
  //     <td data-remaining-seconds="213" …>03:33</td>
  //     <td><img … data-tooltip-content="Expedition" /></td>
  //     <td> Yoyoyoyoyo <a href="/galaxy?x=3&y=269" class="fleet-source-coords">[3:269:8]</a> </td>
  //     <td><span … tooltip with the fleet composition …>
  //
  // The mission type is given BY NAME, not by number — so the whole numbering
  // problem, through which 2.40.0 could read hostility backwards, is gone. Plus
  // source, target, time to arrival and fleet composition.
  const FleetMovements = {
    URL: "/home/fleetmovementlist",
    // v2.75.5: +ACS/FEDERATION/GROUP/HOLD — a GROUP attack ("Players: 1/2" on the
    // events list) went through 07.08 08:2x UNDETECTED: 92.8 bn ships
    // into the base moon, and the classifier only saw a probe ("attacks 0, probes 1")
    // and deleted the candidate. FEDERATION/HOLD sat on the SAFE list due to
    // upstream naming — a foreign mission of those types on OUR body is an attack
    // ACS or hostile stationing, never anything safe.
    ATTACK: /(ATTACK|MISSILE|DESTRUCT|DESTROY|BOMBARD|INVAS|FEDERATION|GROUP|ACS|HOLD)/i,
    SPY: /(ESPIONAGE|SPY|PROBE|SCAN)/i,
    // v2.66.0: types that physically cannot strike (transport doesn't attack,
    // stationing doesn't target others, a return flies home). A foreign mission
    // outside ALL three lists is a type we don't know — we treat it as
    // ATTACK, because a missed attack costs a fleet, while a false alarm costs two flights.
    // v2.75.3: +COLLECT — the debris-collecting type of THIS fork (the "Collect" button
    // in the fleet form). Without it, our own debris flight with a temporarily empty
    // ownBodies() classified as a "type outside the known lists" = attack.
    SAFE: /(TRANSPORT|DEPLOY|STATION|RETURN|EXPEDITION|COLONI|HARVEST|RECYCL|ASTEROID|COLLECT)/i,

    // ── v2.77.0: classifying a SINGLE row as a separate method ──
    // Extracted from the loop without changing a single condition — so that the SELF-TEST
    // (DefenceSelfTest) can call it on synthetic markup, including
    // the same DOM and the same code that handles a real attack.
    // A test that checks a copy of the logic instead of the original is worth
    // as much as no test — that's why there's one original and both places call it.
    classifyRow(tr, own) {
        const type = (String(tr.className).match(/row-mission-type-([A-Z_]+)/i) || [])[1] || "?";
        const srcEl = tr.querySelector(".fleet-source-coords");
        const coords = [...(tr.textContent || "").matchAll(/\[(\d+:\d+:\d+)\]/g)].map(m => m[1]);
        const src = (String(srcEl?.textContent || "").match(/(\d+:\d+:\d+)/) || [])[1] || coords[0] || null;
        const dst = coords.filter(c => c !== src).pop() || null;
        const eta = parseInt(tr.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
        // The fleet composition sits in the tooltip ("Light Cargo : 330.000.000").
        const tip = tr.querySelector("[data-tooltip-content*='Ships']")?.getAttribute("data-tooltip-content") || "";
        const ships = [...tip.matchAll(/>([A-Za-z ]+?)\s*:\s*<\/td>\s*<td[^>]*>([\d.\s]+)</g)]
          .map(m => `${m[1].trim()} ${m[2].trim()}`);
        const isSpy = this.SPY.test(type);
        // v2.75.5: the game itself has the FIRST word — a hostile mission row carries
        // the class `row-hostile-mission` (dumps [ATTACK HOME] from 05-06.08). This
        // is immune to ANY type name (ACS, future fork missions): a hostile
        // non-probe row = attack, no matter what it's called.
        // Rows without that class we classify the old way (by type name).
        const hostileCls = /row-hostile-mission/i.test(String(tr.className));
        // ── v2.86.2: an ALLY's mission is not an attack ──
        // The game marks friends' missions with the row-friendly-mission class (bar:
        // "N Friendly"). Live incident 12.08 12:32: a buddy sent
        // Station (HOLD, 10 probes) to our moon — HOLD is on the
        // ATTACK list after the hostile ACS on 07.08, so the allied visit triggered
        // an hour-long false alarm and fleet bouncing planet↔moon every 90 s.
        // The game's class wins over the type name — symmetric to row-hostile.
        // (A friendly mission mechanically cannot hit us: ACS defend/
        // an ally's stationing defends alongside us.)
        const friendlyCls = /row-friendly-mission/i.test(String(tr.className));
        const isAttack = friendlyCls ? false
          : hostileCls ? !isSpy
          : (this.ATTACK.test(type) || (!isSpy && !this.SAFE.test(type)));
        // ── v2.70.0: body and name at the route ENDS ──
        // Dumps [ATTACK HOME] from 05.08 showed the row carries an icon
        // (moon-icon) and the body name next to the coordinates of both ends. The TARGET body
        // lets us flee deterministically to the opposite body instead of
        // guessing from the "active body" heuristic; the source name is intel.
        const tdOf = (coordStr) => {
          if (!coordStr) return null;
          const a = [...tr.querySelectorAll("a")].find(x => (x.textContent || "").includes(`[${coordStr}]`));
          return a ? a.closest("td") : null;
        };
        const bodyOf = (td) => {
          if (!td) return null;
          return (td.querySelector("img[src*='moon-icon']") || /\bMoon\b/i.test(td.textContent || "")) ? "moon" : "planet";
        };
        const srcTd = (srcEl && srcEl.closest("td")) || tdOf(src);
        const dstTd = tdOf(dst);
        const srcName = srcTd ? ((srcTd.textContent || "").replace(`[${src}]`, "").replace(/\s+/g, " ").trim() || null) : null;
        return {
          srcBody: bodyOf(srcTd),
          srcName,
          dstBody: bodyOf(dstTd),
          id: tr.getAttribute("data-fleet-id") || "",
          type, src, dst, eta,
          mine: !!(src && own.size && own.has(src)),
          friendly: friendlyCls, // v2.86.2: ally — outside the threat counters
          attack: isAttack,
          unknownType: isAttack && !this.ATTACK.test(type),
          spy: isSpy && !friendlyCls,
          ships,
          // v2.67.1: the row's raw HTML — evidence material for the first attack.
          // Without it, a misread of a hostile row would be impossible to diagnose
          // (old one-shot dumps got used up on OUR fleets).
          html: (tr.outerHTML || "").replace(/\s+/g, " ").slice(0, 1800),
        };    },

    // Returns { ok, rows } — ok=false means "don't know", not "safe".
    async fetch() {
      if (!Ajax.supported(this.URL)) return { ok: false, rows: [] };
      let html = "";
      try {
        const res = await fetch(this.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) { Ajax.markUnsupported(this.URL, res.status); return { ok: false, rows: [] }; }
        Ajax.markWorking(this.URL); // v2.61.0: a verified URL won't die from a single 404 hiccup
        html = await res.text();
      } catch { return { ok: false, rows: [] }; }
      if (!html) return { ok: false, rows: [] };
      const doc = new DOMParser().parseFromString(html, "text/html");
      const trs = [...doc.querySelectorAll("tr[class*='row-mission-type-']")];
      if (!trs.length) return { ok: false, rows: [] };
      // v2.57.1: one-time dump of the row END — the action buttons live there,
      // including fleet recall, without which a Fleet Save can't be done.
      if (GM_getValue("ogamex_fml_tail_dumped", "") !== "1") {
        GM_setValue("ogamex_fml_tail_dumped", "1");
        const html = (trs[0].innerHTML || "").replace(/\s+/g, " ");
        log(`[FLEET MOVEMENTS] end of the 1st row (looking for recall): ${html.slice(-1200)}`, "error");
      }
      const own = ThreatMonitor.ownBodies();
      const rows = [];
      for (const tr of trs) rows.push(this.classifyRow(tr, own));
      return { ok: true, rows };
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET SAVE (v2.57.0) — planning, no dispatch yet
  // ═══════════════════════════════════════════════════════════════
  // The arithmetic is simple and certain: a recalled fleet returns exactly as much as
  // it managed to fly. Return = start + 2 × recall delay, and the delay
  // cannot exceed the full one-way flight time (T) — after T the fleet
  // arrives and is no longer en route.
  //
  //   maximum FS from one flight = 2 × T
  //   start = return − 2 × delay      (delay ≤ T)
  //
  // T depends on the route, fleet composition and SPEED. At 10% speed the flight takes
  // ten times longer, so the speed slider is the main tool here.
  // The bot only learns T from the dispatch form (the game shows the flight time in step 2)
  // — that's why the planner works on the measured T and says outright when it doesn't have it yet.
  const FleetSave = {
    KEY: "ogamex_fs_state",
    KEY_T: "ogamex_fs_flight_ms",   // measured one-way flight time

    cfg() { return CONFIG.fleetSave || {}; },
    state() { try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; } },
    save(st) { GM_setValue(this.KEY, JSON.stringify(st)); },

    // v2.75.2: the active body's coordinates from the planet list ROW — the same method
    // as MoonSave.activeCoords (the only one confirmed on this fork; recon
    // showed "planet ?", because the entry text is just the name, the coordinates sit in
    // the row next to it). getCurrentPlanet stays as a second read.
    originCoords() {
      const sel = document.querySelector("a.planet-select.selected, a.moon-select.selected, .planet-select.selected, .moon-select.selected");
      const row = sel?.closest("li, div, tr") || sel?.parentElement;
      const m = String(row?.textContent || "").match(/(\d+):(\d+):(\d+)/);
      if (m) return { galaxy: +m[1], system: +m[2], position: +m[3] };
      return GameState.getCurrentPlanet();
    },

    // Measured flight time for this route and speed (the key covers both).
    routeKey() {
      const c = this.cfg();
      // v2.75.0: FS launches from the CURRENT moon (the owner's decision 06.08,
      // idle-farming event: the fleet wanders between systems) — the flight time is
      // keyed by the actual position, not the old base, so after
      // a teleport the plan forces a fresh measurement instead of computing the recall from
      // the old route's time. c.from stays only as a fallback on
      // pages without the planet bar.
      const o = this.originCoords() || c.from;
      return `${o?.galaxy}:${o?.system}:${o?.position}→${c.to?.galaxy}:${c.to?.system}:${c.to?.position}@${c.speedPercent}`;
    },
    flightMs() {
      try { return JSON.parse(GM_getValue(this.KEY_T, "{}"))[this.routeKey()] || 0; } catch { return 0; }
    },
    noteFlightMs(ms) {
      if (!(ms > 0)) return;
      let all = {};
      try { all = JSON.parse(GM_getValue(this.KEY_T, "{}")); } catch {}
      all[this.routeKey()] = ms;
      GM_setValue(this.KEY_T, JSON.stringify(all));
      log(`[FS] flight time for this route at ${this.cfg().speedPercent}% speed: ${Math.round(ms / 60000)} min → maximum FS ${Math.round(ms / 30000)} min.`, "info");
    },

    // ── v2.60.0: return time as "HH:MM" = the NEAREST such reading ──
    // The owner sets "09:00" once and FS repeats every day: after a finished
    // cycle the next "09:00" is in the future again, so the planner itself computes
    // the next evening. ISO (full date) still works as a one-off.
    returnAtMs(now = Date.now()) {
      const c = this.cfg();
      const raw = String(c.returnAt || "");
      const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
      if (hm) {
        const d = new Date(now);
        d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0);
        if (d.getTime() <= now) d.setDate(d.getDate() + 1);
        return d.getTime();
      }
      const t = Date.parse(raw);
      return Number.isFinite(t) ? t : NaN;
    },

    // Margin: the recall must land clearly BEFORE arrival (delay ≤ T − margin),
    // because after arrival the fleet stations and there is nothing to recall.
    LAUNCH_MARGIN_MS: 3 * 60 * 1000,
    MEASURE_COOLDOWN_MS: 15 * 60 * 1000, // measurement (entering the form without dispatching) at most this often
    RECALL_RETRY_MS: 60 * 1000,
    RECALL_MAX_TRIES: 3,

    // Returns a plan or the reason there is none.
    // ignoreEnabled: the confirmation when ENABLING computes the plan before the flag
    // becomes true (v2.68.3).
    plan(now = Date.now(), { ignoreEnabled = false } = {}) {
      const c = this.cfg();
      if (!c.enabled && !ignoreEnabled) return { ok: false, why: "FS disabled" };
      const at = this.returnAtMs(now);
      if (!Number.isFinite(at)) return { ok: false, why: "no return time set" };
      if (at <= now) return { ok: false, why: "return time has already passed" };
      const T = this.flightMs();
      if (!T) return { ok: false, why: "I don't know this route's flight time — click “Measure route (no dispatch)”", measure: true };
      const window = at - now;
      const maxMs = 2 * T - 2 * this.LAUNCH_MARGIN_MS;
      if (window > maxMs) {
        // ── v2.74.3: we do NOT wait for a "profitable" window — the owner's decision
        // 05.08: "FS must be dispatched immediately, fleet on the moon = goal".
        // Window too long = we fly a CHAIN of full rounds: launch RIGHT AWAY,
        // recall after a full flight (T − margin), return after 2T; after it
        // the planner issues the next round until the last one fits in the window
        // and returns at the set hour. The fleet is in the air the whole time.
        return { ok: true, launchAt: now, recallAt: now + Math.floor(maxMs / 2),
                 returnAt: now + maxMs, delayMs: Math.floor(maxMs / 2), flightMs: T, chained: true };
      }
      // Last (or only) round: recall at half the window = return at the set hour.
      const delay = Math.floor(window / 2);        // ≤ T − margin, since window ≤ 2T − 2·margin
      return { ok: true, launchAt: now, recallAt: now + delay, returnAt: at, delayMs: delay, flightMs: T };
    },

    describe() {
      const st = this.state();
      const f = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      if (st?.phase === "launched") return `FS: fleet EN ROUTE, recall ${f(st.recallAt)}, return ${f(st.returnAt)}`;
      if (st?.phase === "recalled") return `FS: RECALLED, return ~${f(st.returnAt)}`;
      if (st?.phase === "recall_failed") return `FS: RECALL FAILED — the fleet will arrive at the target and stay there. Check the log.`;
      const p = this.plan();
      if (!p.ok) return `FS: ${p.why}`;
      return `FS: launch ${f(p.launchAt)} → recall ${f(p.recallAt)} → return ${f(p.returnAt)}`;
    },

    // ═══ v2.60.0: DISPATCH — state machine ═══
    // idle → (window fits) launched → (recallAt) recalled → (after returnAt) idle.
    // Called from the defense loop (every 30 s, resilient to breaks/jitter/the night window —
    // a recall at 4:00 AM MUST work, so it can't hang on the scheduler,
    // which sleeps during the night window).
    running: false,

    async tick() {
      const st = this.state() || {};
      if (st.phase === "launched") {
        if (Date.now() >= (st.recallAt || 0)) { await this.attemptRecall(st); return; }
        // ── v2.69.3: detect a MANUAL early recall ──
        // 05.08: the owner recalled the morning (mistaken) FS a minute after launch,
        // and at 13:01 the machine still went to recall a non-existent flight — three
        // "RECALL FAILED" messages and a scary message about nothing. Every 5 min a cheap
        // list fetch: our flight missing BEFORE the arrival time = recalled
        // (manually or interrupted) → the cycle closes quietly and right away.
        if (Date.now() - (st.lastRowCheck || 0) > 5 * 60 * 1000) {
          this.save({ ...st, lastRowCheck: Date.now() });
          try {
            const res = await fetch(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
            if (res.ok) {
              const doc = new DOMParser().parseFromString(await res.text(), "text/html");
              const eta = (st.sentAt || 0) + (st.flightMs || 0);
              if (!this._findOurRow(doc, st) && st.flightMs && Date.now() < eta - 60000) {
                this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
                log("[FS] the flight is not on the list before the arrival time — it was recalled (most likely manually). Closing the cycle without alarms.", "info");
                try { updateStatusUI(); } catch {}
              }
            }
          } catch {}
        }
        return;
      }
      if (st.phase === "recalled" || st.phase === "recall_failed") {
        // Cycle closed 10 min after the planned return; with "HH:MM" the next
        // evening the planner will issue the next launch itself.
        if (Date.now() > (st.returnAt || 0) + 10 * 60 * 1000) {
          this.save(null);
          log(`[FS] cycle closed (${st.phase === "recalled" ? "fleet returned" : "fleet stayed at the target — pull it back manually"}).`, st.phase === "recalled" ? "success" : "warn");
        }
        return;
      }
      // idle phase — time to launch?
      const c = this.cfg();
      if (!CONFIG.enabled || !c.enabled || this.running) return;
      // The alert has absolute priority: when MoonSave evacuates/guards the base,
      // FS must not snatch the fleet out from under it.
      if (ThreatMonitor.active() || MoonSave.watch().armed) return;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return; // FS can wait 30 s, the routine doesn't have to be preempted
      // v2.66.0: a failed launch (e.g. empty moon) is not retried every tick.
      const failAt = parseInt(GM_getValue("ogamex_fs_fail_at", "0")) || 0;
      if (Date.now() - failAt < 10 * 60 * 1000) return;
      // v2.75.0: launch from the current body — FS waits until the moon is active
      // (the owner moves the fleet during the event; a dispatch from the planet would be
      // visible in the phalanx, so we do NOT launch from the planet).
      if (MoonSave.currentBody() !== "moon") {
        const warnAt = parseInt(GM_getValue("ogamex_fs_body_warn_at", "0")) || 0;
        if (Date.now() - warnAt > 10 * 60 * 1000) {
          GM_setValue("ogamex_fs_body_warn_at", String(Date.now()));
          log("[FS] holding the launch: the active body is not a moon — switch to the moon I'm supposed to send FS from.", "warn");
        }
        return;
      }
      const p = this.plan();
      if (!p.ok && !p.measure) return;           // too early / disabled / no hour set
      if (!p.ok && p.measure) {
        // We don't know T: enter the form, measure and DON'T dispatch (the gate in step 2
        // will refuse, because window >> 2T with an unknown T always ends in a refusal or
        // a measurement). Rare — it's navigation with form filling.
        const lastTry = parseInt(GM_getValue("ogamex_fs_measure_at", "0")) || 0;
        if (Date.now() - lastTry < this.MEASURE_COOLDOWN_MS) return;
        GM_setValue("ogamex_fs_measure_at", String(Date.now()));
        return this.launch({ measure: true });
      }
      return this.launch({ plan: p });
    },

    // Launch: from the moon the owner is CURRENTLY on (v2.75.0 — without
    // switching to the old base; the form dispatches from the active body).
    // atCoords = the current position, so that switch_to_body — if in the meantime
    // the planet became active — returns to the moon of THAT pair, not the base.
    // v2.74.3: the plan from the tick carries the ROUND's returnAt (in a chain ≠ the final
    // hour from the panel) — the 2T gate in step 2 and markLaunched rely on it.
    launch({ measure = false, plan = null } = {}) {
      const c = this.cfg();
      const to = c.to;
      if (!to || !Number.isFinite(to.galaxy)) { log("[FS] no target in the configuration — set “Target” in the FS panel.", "error"); return false; }
      const from = this.originCoords();
      if (MoonSave.currentBody() !== "moon" || !from) { log("[FS] not launching: the active body is not a moon or I can't see a position on this page.", "warn"); return false; }
      const at = (plan && plan.returnAt) || this.returnAtMs();
      if (!measure && !Number.isFinite(at)) return false;
      GM_setValue("pending_mission", JSON.stringify({
        type: "fleet_save_direct",
        fleetSave: true,
        fsMeasure: measure,
        atCoords: from,
        launchBody: "moon",
        targetBody: "moon",
        fleetUrl: `/fleet?x=${to.galaxy}&y=${to.system}&z=${to.position}`,
        returnAtMs: at || 0,
        speedPercent: c.speedPercent,
        step: "switch_to_body",
        timestamp: Date.now(),
      }));
      log(measure
        ? `[FS] measuring the route [${from.galaxy}:${from.system}:${from.position}]→[${to.galaxy}:${to.system}:${to.position}] at ${c.speedPercent}% — I'll fill the form, read the flight time and EXIT without dispatching.`
        : `[FS] launching: moon [${from.galaxy}:${from.system}:${from.position}] → moon [${to.galaxy}:${to.system}:${to.position}], station with recall, return ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`, "info");
      if (!measure) ThreatLog.add("FS", `FS launch to [${to.galaxy}:${to.system}:${to.position}], return ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.`);
      return true;
    },

    // Stamped after a CONFIRMED dispatch (finishDispatch or the
    // fleetSendSuccessfully page). recallAt computed from NOW: return = now + window,
    // recall at half the window.
    markLaunched(pm) {
      const sentAt = Date.now();
      const returnAt = pm.returnAtMs || this.returnAtMs();
      const recallAt = sentAt + Math.floor(Math.max(0, returnAt - sentAt) / 2);
      this.save({ phase: "launched", sentAt, recallAt, returnAt, flightMs: pm.capturedFlightMs || 0, tries: 0,
                  from: pm.atCoords || this.cfg().from, to: this.cfg().to });
      const f = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      log(`[FS] SENT. Recall ${f(recallAt)}, return ~${f(returnAt)}.`, "success");
      ThreatLog.add("FS", `Fleet en route. Recall ${f(recallAt)}, return ~${f(returnAt)}.`);
      try { updateStatusUI(); } catch {}
    },

    // ═══ RECALL ═══
    // No one has seen the recall control yet (a dump is waiting in
    // FleetMovements.fetch). We look for it by MEANING (recall/callback/retreat/
    // revoke/cancel/recall) in OUR row; nothing matches → dump + loud
    // error + the fleet WILL ARRIVE on our own moon and stay there (stationing
    // = safe failure; we reject transport already at dispatch).
    RECALL_RX: /recall|call.?back|revoke|retreat|withdraw|cancel|abort|zawr[oó]|cofnij/i,
    _recalling: false,

    _findOurRow(doc, st = null) {
      const c = this.cfg();
      // v2.75.3: we recognize the flight by the coordinates STAMPED at dispatch —
      // since v2.75.0 FS launches from the current moon, so c.from (the old base)
      // no longer describes the route; searching by it wouldn't find our row
      // and the recall would be lost (the fleet would station at the target).
      const f = st?.from || c.from;
      const t = st?.to || c.to;
      const fromS = `${f?.galaxy}:${f?.system}:${f?.position}`;
      const toS = `${t?.galaxy}:${t?.system}:${t?.position}`;
      for (const tr of doc.querySelectorAll("tr[class*='row-mission-type-']")) {
        const t = tr.textContent || "";
        if (t.includes(`[${fromS}]`) && t.includes(`[${toS}]`)) return tr;
      }
      return null;
    },

    async attemptRecall(st) {
      if (this._recalling) return;
      this._recalling = true;
      try {
        let html = "";
        try {
          const res = await fetch(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (res.ok) html = await res.text();
        } catch {}
        if (!html) { this._recallFail(st, "the fleet movements list is not responding"); return; }
        const doc = new DOMParser().parseFromString(html, "text/html");
        const row = this._findOurRow(doc, st);
        if (!row) {
          // No row: the fleet already arrived (too late) or was already recalled.
          // v2.69.3: no row BEFORE the arrival time = flight recalled (e.g.
          // manually) — that's a cycle success, not a failure. Only
          // a missing row AFTER arrival is a failure (the fleet stations at the target).
          const etaAbs = (st.sentAt || 0) + (st.flightMs || 0);
          if (st.flightMs && Date.now() < etaAbs - 60000) {
            this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
            log("[FS] the flight is not on the list before the arrival time — it was recalled (most likely manually). Closing the cycle.", "info");
            try { updateStatusUI(); } catch {}
            return;
          }
          this._recallFail(st, "I can't find our flight on the movements list (arrived? already recalled?)");
          return;
        }
        const fleetId = row.getAttribute("data-fleet-id") || "";
        const etaBefore = parseInt(row.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
        // ── v2.66.9: the REAL control, caught live at 15:33 ──
        //   <a href="#" class="x_btn_fleet_return tooltip" data-fleet-id="…">
        // href="#" = a pure JS handler, so fetch gets nothing — you have to CLICK
        // in the live DOM (the list renders in the "Fleet movements" panel on
        // /fleet). The earlier detector deliberately didn't search for the word "return"
        // (it would collide with return flights) — and that's why it missed the
        // x_btn_fleet_return class.
        const returnBtnInRow = row.querySelector("a.x_btn_fleet_return, [class*='btn_fleet_return'], [class*='fleet_return']");
        // The flight is already returning (e.g. recalled manually): a row without a recall button
        // + a return marker = nothing to recall, goal achieved.
        if (!returnBtnInRow && /data-return-flight="true"|\(R\)|return/i.test(row.outerHTML)) {
          this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
          log("[FS] the flight is already on its way back (recalled — possibly manually). I consider the recall done.", "success");
          ThreatLog.add("FS", "Flight detected as returning — recall executed (possibly manually).");
          try { updateStatusUI(); } catch {}
          return;
        }
        // fallback control: a link with a real href, a form, or a data attribute
        const link = [...row.querySelectorAll("a[href]")].find(a =>
          (a.getAttribute("href") || "#") !== "#" && (
            this.RECALL_RX.test(a.getAttribute("href") || "") || this.RECALL_RX.test(String(a.className || ""))
            || this.RECALL_RX.test(a.getAttribute("data-tooltip-content") || "") || this.RECALL_RX.test(a.textContent || "")));
        const form = [...row.querySelectorAll("form")].find(f => this.RECALL_RX.test(f.getAttribute("action") || ""));
        const dataEl = link || form ? null : [...row.querySelectorAll("[data-url], [data-href], [data-action]")].find(el =>
          this.RECALL_RX.test(el.getAttribute("data-url") || el.getAttribute("data-href") || el.getAttribute("data-action") || ""));
        if (!returnBtnInRow && !link && !form && !dataEl) {
          // The rule from the note: we don't guess markup. A dump of the row end to the log
          // (forced, not one-shot) and a loud failure.
          log(`[FS] CAN'T FIND the recall control in the flight row. Row end: ${(row.innerHTML || "").replace(/\s+/g, " ").slice(-1200)}`, "error");
          this._recallFail(st, "no recall control in the row markup (dump in the log — send it to me, I'll add the selector)");
          return;
        }
        if (link || form || dataEl) {
          // HTTP path — in case another build gives a real address
          const target = link ? link.getAttribute("href")
            : form ? form.getAttribute("action")
            : (dataEl.getAttribute("data-url") || dataEl.getAttribute("data-href") || dataEl.getAttribute("data-action"));
          log(`[FS] recalling the fleet (${link ? "link" : form ? "form" : "data attribute"}: ${target}).`, "info");
          try {
            if (form) {
              const params = new URLSearchParams();
              for (const inp of form.querySelectorAll("input[name]")) params.set(inp.getAttribute("name"), inp.getAttribute("value") || "");
              const tok = Ajax.token(); if (tok && !params.has("_token")) params.set("_token", tok);
              await fetch(target, {
                method: (form.getAttribute("method") || "POST").toUpperCase(),
                headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                body: params.toString(), credentials: "same-origin",
              });
            } else {
              await fetch(target, { headers: { "X-Requested-With": "XMLHttpRequest" }, credentials: "same-origin" });
            }
          } catch (e) { this._recallFail(st, `the recall request failed: ${e.message}`); return; }
        } else {
          // ── click in the live DOM ──
          const btnId = returnBtnInRow.getAttribute("data-fleet-id") || fleetId;
          const findLive = () => (btnId
            ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${btnId}"]`)
            : document.querySelector("a.x_btn_fleet_return"));
          let live = findLive();
          if (!live) {
            // v2.74.0: the fleet list rows render ONLY after expanding
            // — confirmed live 05.08 23:08 (the owner expanded it manually
            // and exactly the same click went through). So we expand like a human:
            // candidates are "Fleet movements", the "Events" heading and the mission bar
            // ("N Missions"); after the click we POLL for up to 4 s, because the rows arrive
            // asynchronously (1.5 s sometimes wasn't enough).
            const cands = [...document.querySelectorAll("a, button, div, span, h2, h3")]
              .filter(e => e.offsetParent !== null && !e.closest("#ogx-bot-panel"))
              .filter(e => {
                const t = (e.textContent || "").trim();
                return t.length > 0 && t.length < 60 && /fleet\s*movements|^events$|\d+\s*Missions?/i.test(t);
              });
            log(`[FS] the recall button is not in the live DOM — trying to expand the fleet list (${cands.length} candidates).`, "info");
            for (const t of cands) {
              t.click();
              for (let i = 0; i < 8 && !live; i++) { await AntiDetection.sleep(500); live = findLive(); }
              if (live) { log(`[FS] fleet list expanded ("${(t.textContent || "").trim().slice(0, 30)}") — the recall button is visible.`, "success"); break; }
            }
          }
          if (!live) {
            // Wrong page (list only in the data) — go to /fleet and try
            // in the next pass of the defense loop. Max 2 navigations per cycle.
            const navs = (st.recallNavs || 0) + 1;
            if (navs <= 2) {
              this.save({ ...st, recallNavs: navs });
              log(`[FS] the recall button is in the data but not on this page — going to /fleet (${navs}/2) to click it.`, "info");
              window.location.replace("/fleet");
              return;
            }
            this._recallFail(st, "the x_btn_fleet_return button is in the list data, but I can't reach it in the live DOM");
            return;
          }
          log(`[FS] clicking recall (a.x_btn_fleet_return, flight ${(btnId || "?").slice(0, 8)}…).`, "info");
          // If the game asked with a native confirm(), the click would stall on it —
          // for the duration of the click we answer "yes".
          const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
          const origConfirm = w.confirm;
          try { w.confirm = () => true; live.click(); await AntiDetection.sleep(800); }
          finally { try { w.confirm = origConfirm; } catch {} }
          // Confirmation dialog in the DOM (if any) — click only within the modal.
          const confirmBtn = [...document.querySelectorAll("button, a, input[type='button'], input[type='submit']")]
            .find(e => e.offsetParent !== null && !e.closest("#ogx-bot-panel")
              && e.closest("[class*='modal'], [class*='dialog'], [class*='popup'], [class*='confirm']")
              && /^(ok|yes|tak|confirm|potwierd)/i.test((e.value || e.textContent || "").trim()));
          if (confirmBtn) { confirmBtn.click(); await AntiDetection.sleep(500); }
        }
        // ── verification: a recalled flight CHANGES the row ──
        await AntiDetection.sleep(4000);
        let ok = false;
        try {
          const res2 = await fetch(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          const doc2 = res2.ok ? new DOMParser().parseFromString(await res2.text(), "text/html") : null;
          const row2 = doc2 && (fleetId ? doc2.querySelector(`tr[data-fleet-id="${fleetId}"]`) : this._findOurRow(doc2));
          if (!row2) ok = true;                                        // row rekeyed/disappeared
          else if (/return|powr|zawr/i.test(row2.className + " " + (row2.textContent || ""))) ok = true;
          else {
            const etaAfter = parseInt(row2.querySelector("[data-remaining-seconds]")?.getAttribute("data-remaining-seconds") || "0") || 0;
            // normal flight: eta dropped by ~5s; recalled: eta JUMPS to the return time
            if (Math.abs(etaAfter - (etaBefore - 5)) > 30) ok = true;
          }
        } catch {}
        if (ok) {
          this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
          const f = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
          log(`[FS] RECALLED — return ~${f(st.returnAt)}.`, "success");
          ThreatLog.add("FS", `Fleet recalled, return ~${f(st.returnAt)}.`);
          try { updateStatusUI(); } catch {}
        } else {
          this._recallFail(st, "after the recall the flight row looks the same — the recall most likely did NOT work");
        }
      } finally {
        this._recalling = false;
      }
    },

    _recallFail(st, why) {
      const tries = (st.tries || 0) + 1;
      if (tries < this.RECALL_MAX_TRIES) {
        this.save({ ...st, tries, recallAt: Date.now() + this.RECALL_RETRY_MS });
        log(`[FS] recall failed (${tries}/${this.RECALL_MAX_TRIES}): ${why}. Retrying in ${Math.round(this.RECALL_RETRY_MS / 1000)}s.`, "warn");
        return;
      }
      this.save({ ...st, phase: "recall_failed", tries });
      log(`[FS] RECALL FAILED after ${tries} attempts: ${why}. The fleet WILL ARRIVE on our moon and stay there (stationing) — pull it back manually or with the button when you're up.`, "error");
      ThreatLog.add("ERROR", `FS: recall failed (${why}). The fleet will stay at the target — safe, but it won't come back on its own.`);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("OGameX: FS — recall failed", { body: "The fleet will arrive at the target and stay there. Check the log.", tag: "ogamex-fs" });
        }
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  EVENTS PANEL (v2.88.0) — third source: the live DOM of the Events panel
  // ═══════════════════════════════════════════════════════════════
  // 13:07 (fleet loss): an attack from the system was INVISIBLE to the movement list
  // and event endpoints — the only trace was a bare bar counter (no target,
  // ETA or body), so neither a blitz nor an air save would trigger.
  // But the Events panel RENDERS on the page (/home, /fleet) with the full set:
  // mission type, countdown, source, target + moon icon. We read it from the DOM
  // with a parser shaped like fetchServerEvents (tr.eventFleet + .coordsOrigin
  // + .destCoords — we do NOT guess new markup); if the fork renders
  // differently, a one-time [EVENTS DOM] dump to the log, and we'll add the selectors
  // from the facts. The read lives 3 min as a cache (galaxy pages have no panel —
  // same lesson as the bar cache).
  const EventsPanel = {
    KEY_CACHE: "ogamex_events_panel_cache",
    KEY_DUMPED: "ogamex_events_panel_dumped_v2882",

    _parseTr(tr, own) {
      if (tr.dataset.returnFlight === "true") return null;      // our return
      const type = parseInt(tr.dataset.missionType || "0") || 0;
      const oc = (tr.querySelector(".coordsOrigin")?.textContent || "").match(/(\d+):(\d+):(\d+)/);
      const dcEl = tr.querySelector(".destCoords");
      const dc = ((dcEl && dcEl.textContent) || "").match(/(\d+):(\d+):(\d+)/);
      if (!dc) return null;                                     // a row without a target adds nothing
      const src = oc ? oc[0] : null;
      if (own.size && src && own.has(src)) return null;         // our own mission
      const isSpy = type === ThreatMonitor.ESPIONAGE_TYPE;
      const isAttack = !isSpy && ThreatMonitor.ATTACK_TYPES.includes(type);
      if (!isSpy && !isAttack) return null;                     // type outside the known ones — careful: the bar path remains
      // ETA: data-arrival-time (epoch s) or the countdown in the row.
      let eta = 0;
      const arr = parseInt(tr.dataset.arrivalTime || "0") || 0;
      if (arr > 0) eta = Math.max(0, Math.round(arr - Date.now() / 1000));
      if (!eta) {
        const t = tr.textContent || "";
        const cd = t.match(/\b(\d{1,2}):(\d{2}):(\d{2})\b/) || t.match(/\b(\d{1,2}):(\d{2})\b/);
        if (cd) eta = cd[3] !== undefined ? (+cd[1] * 3600 + +cd[2] * 60 + +cd[3]) : (+cd[1] * 60 + +cd[2]);
      }
      const dstBody = (dcEl.querySelector("img[src*='moon']") || /\bMoon\b/i.test(dcEl.textContent || "")) ? "moon" : "planet";
      return {
        mine: false, friendly: false, attack: isAttack, spy: isSpy, unknownType: false,
        type: String(type), src, srcBody: null, srcName: null, dst: dc[0], dstBody, eta,
        ships: [], html: (tr.outerHTML || "").replace(/\s+/g, " ").slice(0, 600), panel: true,
      };
    },

    read() {
      const own = ThreatMonitor.ownBodies();
      // ── Shape A: upstream tr.eventFleet with NUMERIC mission numbering ──
      // Only with reliable numbering — otherwise the numeric types mean nothing.
      if (GM_getValue("ogamex_mission_numbering_warned", "") !== "1") {
        const trs = [...document.querySelectorAll("tr.eventFleet[data-mission-type]")];
        if (trs.length) {
          const rows = [];
          for (const tr of trs) { const r = this._parseTr(tr, own); if (r) rows.push(r); }
          this._cache(rows);
          return rows;
        }
      }
      // ── Shape B (v2.88.2): the fork renders the panel with movement-list rows ──
      // The [EVENTS DOM] dump from 12.08 16:10 showed the fork's container:
      // #layoutFleetMovements > #fleet-movement-content (it was empty because
      // the "foreign" fleet came from a blind-bar simulation). The hostile rows of this
      // fork are tr[class*='row-mission-type-'] (from [ATTACK DOM] dumps) —
      // we read them with the REAL FleetMovements.classifyRow: no new
      // parser, the classification is battle-tested (row-hostile/row-friendly)
      // and pinned down by an autotest. Numeric numbering does not apply to it.
      const panelTrs = [...document.querySelectorAll("#fleet-movement-content tr[class*='row-mission-type-'], #layoutFleetMovements tr[class*='row-mission-type-']")];
      if (panelTrs.length) {
        const rows = [];
        for (const tr of panelTrs) {
          let r = null; try { r = FleetMovements.classifyRow(tr, own); } catch {}
          if (!r || r.mine || r.friendly || !r.dst) continue;
          if (!r.attack && !r.spy) continue;
          rows.push({ ...r, panel: true });
        }
        this._cache(rows);
        return rows;
      }
      this._maybeDump();
      try {
        const c = JSON.parse(GM_getValue(this.KEY_CACHE, "null"));
        if (c && Date.now() - c.at < 3 * 60 * 1000) {
          return (c.rows || [])
            .filter(r => (r.arriveAt || 0) - Date.now() > -60000)   // ETA passed >1 min ago = all over
            .map(r => ({ ...r, eta: Math.max(0, Math.round(((r.arriveAt || 0) - Date.now()) / 1000)) }));
        }
      } catch {}
      return [];
    },

    _cache(rows) {
      GM_setValue(this.KEY_CACHE, JSON.stringify({
        at: Date.now(),
        rows: rows.map(r => ({ ...r, arriveAt: Date.now() + (r.eta || 0) * 1000 })),
      }));
    },

    // Fork without known rows: a ONE-TIME dump of the Events container to the log.
    // v2.88.2 (16:10 lesson): the dump does NOT fire on simulation (a synthetic
    // foreign fleet = the panel is rightly empty) nor on an empty container — burning
    // the only dump on nothing would waste the only chance at the markup.
    _maybeDump() {
      if (GM_getValue(this.KEY_DUMPED, "") === "1") return;
      let bar = null;
      try { bar = ThreatMonitor.read(); } catch {}
      if (!bar || bar.sim || bar.foreign < 1) return;
      let el = document.querySelector("#fleet-movement-content") || document.querySelector("#layoutFleetMovements");
      if (!el) {
        const hdr = [...document.querySelectorAll("div, span, h1, h2, h3, td")]
          .find(e => (e.textContent || "").trim() === "Events" && !e.closest("#ogx-bot-panel"));
        if (!hdr) return;
        el = hdr.closest("table") || (hdr.parentElement && hdr.parentElement.parentElement) || hdr.parentElement;
      }
      if (!el || !el.children || el.children.length === 0) return; // an empty container teaches nothing
      const html = (el.outerHTML || "").replace(/\s+/g, " ");
      if (html.length < 100) return;
      GM_setValue(this.KEY_DUMPED, "1");
      log(`[EVENTS DOM] Events panel without known rows — dump for writing the fork's selectors (send this line): ${html.slice(0, 3000)}`, "error");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  AIR SAVE (v2.85.0) — MID-AIR ESCAPE from an attack on both bodies of a pair
  // ═══════════════════════════════════════════════════════════════
  // The only scenario in which a moon↔planet evacuation does NOT save the fleet:
  // the attacker hits the planet and the moon of the same pair SIMULTANEOUSLY
  // (the classic: DS "destroy moon" + attack on the planet). The response agreed
  // with the owner (OPEN since 07.08, green light on 12.08): send EVERYTHING
  // with a slow Deploy to another colony and RECALL after the attacks pass —
  // a fleet in flight is untouchable, and recalling a flight that starts
  // from the moon is invisible to the phalanx.
  //
  // A layer ON the existing path (defense change strategy):
  //   • fires ONLY when the movement list shows attacks on BOTH bodies
  //     of one pair (ev.targetBodiesAll) — any other attack takes the old,
  //     battle-proven rescue path;
  //   • any failure (no refuge, flight too short, no recall
  //     button) = a loud log entry + the colony back on the usual rescue
  //     via markFailed — the regression floor is 2.84.0 behavior;
  //   • the dispatch goes through the proven rescue form (all ships,
  //     all resources minus the deuterium reserve), the FS code sets the speed,
  //     recall clicks the same x_btn_fleet_return control that FS
  //     has been recalling live since v2.66.9.
  const AirSave = {
    KEY: "ogamex_airsave",
    KEY_FAIL: "ogamex_airsave_fail",
    RECALL_BUFFER_MS: 120000,   // recall: last attack ETA + 2 min of buffer

    enabled() { return CONFIG.threatAlarm?.airSave !== false; },
    state() { try { return JSON.parse(GM_getValue(this.KEY, "null")) || {}; } catch { return {}; } },
    save(st) { GM_setValue(this.KEY, st ? JSON.stringify(st) : "null"); },

    key(c) { return c && Number.isFinite(c.galaxy) ? `${c.galaxy}:${c.system}:${c.position}` : null; },

    // A PURE decision — no DOM, no network, no system clock. Tested
    // offline (test-air save.js) and called live by MoonSave.run().
    decide({ enabled, bodies, activePhase, failedAt, now }) {
      if (!enabled) return "swap";
      if (activePhase === "launched" || activePhase === "recalled" || activePhase === "arming") return "active";
      if (!bodies || bodies.length < 2) return "swap";
      if (failedAt && now - failedAt < 10 * 60 * 1000) return "swap";
      return "air";
    },

    // PURE recall arithmetic: last ETA + buffer.
    recallAtFor(maxEtaSec, now) { return now + Math.max(0, maxEtaSec || 0) * 1000 + this.RECALL_BUFFER_MS; },

    decideFor(atCoords) {
      const k = this.key(atCoords);
      if (!k) return "swap";
      let ev = null;
      try { ev = ThreatMonitor.events(); } catch {}
      let failedAt = 0;
      try { failedAt = (JSON.parse(GM_getValue(this.KEY_FAIL, "{}")) || {})[k] || 0; } catch {}
      const st = this.state();
      return this.decide({
        enabled: this.enabled(),
        bodies: (ev?.targetBodiesAll || {})[k] || [],
        activePhase: (st.phase && this.key(st.at) === k) ? st.phase : null,
        failedAt,
        now: Date.now(),
      });
    },

    markFailed(atCoords, why) {
      const k = this.key(atCoords);
      if (!k) return;
      let m = {};
      try { m = JSON.parse(GM_getValue(this.KEY_FAIL, "{}")) || {}; } catch {}
      m[k] = Date.now();
      GM_setValue(this.KEY_FAIL, JSON.stringify(m));
      DefenceWatchdog.note(`air save failed (${why}) — colony [${k}] falls back to the usual rescue`);
    },

    // The nearest OWN colony outside the attacked pair (from the planet bar;
    // prefer the same galaxy — we fly slowly anyway, what matters is the ETA,
    // which will never happen).
    refuge(atCoords) {
      const list = [];
      for (const p of document.querySelectorAll("a.planet-select, .planet-select")) {
        const m = (p.textContent || "").replace(/\s+/g, " ").match(/(\d+):(\d+):(\d+)/);
        if (m) list.push({ galaxy: +m[1], system: +m[2], position: +m[3] });
      }
      const k = this.key(atCoords);
      const own = list.filter(c => this.key(c) !== k);
      if (!own.length) return null;
      const sameGal = own.filter(c => c.galaxy === atCoords.galaxy);
      const pool = sameGal.length ? sameGal : own;
      pool.sort((a, b) => Math.abs(a.system - atCoords.system) - Math.abs(b.system - atCoords.system));
      return pool[0];
    },

    // The dispatch. Called from MoonSave.run() — the active colony is already the attacked
    // pair (autoSaveOnThreat switched earlier). Returns true when
    // the mission launched; false = fall back to the usual rescue.
    async launch(atCoords, reason, maxEtaSec) {
      const to = this.refuge(atCoords);
      if (!to) {
        log("[AIR SAVE] I don't see any other colony on the planet bar — falling back to the usual rescue.", "error");
        this.markFailed(atCoords, "no refuge on the planet bar");
        return false;
      }
      const holdUntilMs = this.recallAtFor(maxEtaSec, Date.now());
      const speed = Math.max(1, Math.min(100, parseInt(CONFIG.fleetSave?.speedPercent) || 10));
      GM_setValue("pending_mission", JSON.stringify({
        type: "air_save_direct",
        moonSave: true,          // rescue form: all ships + resources − deuterium reserve
        airSave: true,
        atCoords,                // attacked pair (for the empty-hangar flip)
        holdUntilMs,             // when to recall: last ETA + buffer
        speedPercent: speed,     // slow = long flight = we'll always manage to recall
        fleetUrl: `/fleet?x=${to.galaxy}&y=${to.system}&z=${to.position}`,
        step: "select_ships_direct",
        timestamp: Date.now(),
      }));
      this.save({ phase: "arming", at: atCoords, to, holdUntilMs, reason, createdAt: Date.now() });
      DefenceHold.stamp();
      const hhmm = new Date(holdUntilMs).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      log(`AIR SAVE: attack on BOTH bodies [${this.key(atCoords)}] — sending EVERYTHING with a slow Deploy (${speed}%) to [${this.key(to)}], will recall ~${hhmm} (after the attacks pass).`, "error");
      ThreatLog.add("RESCUE", `AIR SAVE: both bodies [${this.key(atCoords)}] under attack — the fleet flies to [${this.key(to)}] (${speed}%), recall ~${hhmm}.`);
      await AntiDetection.sleep(300 + Math.random() * 400);
      window.location.replace(`/fleet?x=${to.galaxy}&y=${to.system}&z=${to.position}`);
      return true;
    },

    // After a confirmed dispatch (finishDispatch AND fleetSendSuccessfully —
    // both paths can fire for the same dispatch, hence the 15 s dedup).
    afterSend(mission) {
      const st = this.state();
      if (st.phase === "launched" && Date.now() - (st.sentAt || 0) < 15000) return;
      this.save({
        ...st,
        phase: "launched",
        sentAt: Date.now(),
        flightMs: (mission && mission.flightMs) || st.flightMs || 0,
        recallAt: (mission && mission.holdUntilMs) || st.holdUntilMs || (Date.now() + this.RECALL_BUFFER_MS),
        at: st.at || (mission && mission.atCoords) || null,
      });
      updateStatusUI();
    },

    // Tick in the defense loop (before FS): watches over the recall and closes the cycle.
    async tick() {
      const st = this.state();
      if (!st.phase) return;
      if (st.phase === "arming") {
        // The dispatch wasn't confirmed within 5 min = the mission died in the form.
        if (Date.now() - (st.createdAt || 0) > 5 * 60 * 1000) {
          this.save(null);
          this.markFailed(st.at, "dispatch not confirmed within 5 min");
          log("[AIR SAVE] dispatch not confirmed within 5 min — state cleared, the colony falls back to the usual rescue.", "error");
        }
        return;
      }
      if (st.phase === "launched") {
        DefenceWatchdog.note("air save in flight — recall by the clock");
        if (Date.now() >= (st.recallAt || 0)) await this._recall(st);
        return;
      }
      if (st.phase === "recalled") {
        // The return takes as long as the flight did until the recall; close it with margin.
        const backMs = Math.max(60000, (st.recalledAt || 0) - (st.sentAt || 0));
        if (Date.now() > (st.recalledAt || 0) + backMs + 10 * 60 * 1000) {
          this.save(null);
          log("[AIR SAVE] cycle closed — the fleet should be back home. Take a look at the hangar.", "success");
        }
        return;
      }
      if (st.phase === "recall_failed") {
        // A persistent state until cleaned up manually — remind every 15 min.
        if (Date.now() - (st.nagAt || 0) > 15 * 60 * 1000) {
          this.save({ ...st, nagAt: Date.now() });
          log(`[AIR SAVE] the fleet was NOT recalled — it will arrive / has arrived at [${this.key(st.to)}]. Bring it back manually (return Deploy); the state will clear itself after 2 h.`, "error");
        }
        if (Date.now() - (st.createdAt || st.sentAt || 0) > 2 * 60 * 60 * 1000) this.save(null);
      }
    },

    // Our flight: Deploy/station from the attacked pair to the refuge, non-returning.
    _findOurRow(doc, st) {
      const toKey = this.key(st.to), atKey = this.key(st.at);
      for (const tr of doc.querySelectorAll("tr[class*='row-mission-type-']")) {
        const cls = String(tr.className);
        if (!/DEPLOY|STATION/i.test(cls)) continue;
        if (/return/i.test(cls)) continue;
        const txt = tr.textContent || "";
        if (toKey && txt.includes(`[${toKey}]`) && atKey && txt.includes(`[${atKey}]`)) return tr;
      }
      return null;
    },

    async _recall(st) {
      if (this._recalling) return;
      this._recalling = true;
      try {
        const tries = (st.recallTries || 0) + 1;
        this.save({ ...st, recallTries: tries });
        if (tries > 5) {
          this.save({ ...st, phase: "recall_failed" });
          log("[AIR SAVE] 5 failed recall attempts — the fleet WILL arrive at the refuge and stay there (safe, but away from home). Bring it back manually.", "error");
          ThreatLog.add("ERROR", `Air save: recall failed 5×. The fleet will arrive at [${this.key(st.to)}] — bring it back manually.`);
          return;
        }
        let html = "";
        try {
          const res = await fetch(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          if (res.ok) html = await res.text();
        } catch {}
        if (!html) { log("[AIR SAVE] the fleet movement list is not responding — I'll retry on the next pass.", "warn"); return; }
        const doc = new DOMParser().parseFromString(html, "text/html");
        const row = this._findOurRow(doc, st);
        if (!row) {
          const etaAbs = (st.sentAt || 0) + (st.flightMs || 0);
          if (st.flightMs && Date.now() < etaAbs - 60000) {
            this.save({ ...st, phase: "recalled", recalledAt: Date.now() });
            log("[AIR SAVE] the flight is not on the list before its ETA — it was recalled (possibly manually). Closing the cycle.", "info");
          } else {
            this.save({ ...st, phase: "recall_failed" });
            log("[AIR SAVE] I can't find our flight on the list — did it arrive at the refuge? Bring the fleet back manually.", "error");
            ThreatLog.add("ERROR", `Air save: the flight vanished from the list (arrived?). The fleet is at [${this.key(st.to)}] — bring it back manually.`);
          }
          return;
        }
        // Click x_btn_fleet_return — exactly the FS path (confirmed live).
        const fleetId = row.getAttribute("data-fleet-id") || "";
        const findLive = () => (fleetId
          ? document.querySelector(`a.x_btn_fleet_return[data-fleet-id="${fleetId}"]`)
          : document.querySelector("a.x_btn_fleet_return"));
        let live = findLive();
        if (!live) {
          const cands = [...document.querySelectorAll("a, button, div, span, h2, h3")]
            .filter(e => e.offsetParent !== null && !e.closest("#ogx-bot-panel"))
            .filter(e => { const t = (e.textContent || "").trim(); return t.length > 0 && t.length < 60 && /fleet\s*movements|^events$|\d+\s*Missions?/i.test(t); });
          for (const t of cands) {
            t.click();
            for (let i = 0; i < 8 && !live; i++) { await AntiDetection.sleep(500); live = findLive(); }
            if (live) break;
          }
        }
        if (!live) {
          const navs = (st.recallNavs || 0) + 1;
          if (navs <= 2) {
            this.save({ ...st, recallTries: tries - 1, recallNavs: navs }); // navigation doesn't eat an attempt
            log(`[AIR SAVE] the recall button is not on this page — navigating to /fleet (${navs}/2).`, "info");
            window.location.replace("/fleet");
            return;
          }
          log(`[AIR SAVE] I can't reach the recall button (attempt ${tries}/5) — I'll retry.`, "warn");
          return;
        }
        const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
        const orig = w.confirm;
        try { w.confirm = () => true; live.click(); await AntiDetection.sleep(800); }
        finally { try { w.confirm = orig; } catch {} }
        await AntiDetection.sleep(4000);
        let ok = false;
        try {
          const res2 = await fetch(FleetMovements.URL, { headers: { "X-Requested-With": "XMLHttpRequest" } });
          const doc2 = res2.ok ? new DOMParser().parseFromString(await res2.text(), "text/html") : null;
          const row2 = doc2 && (fleetId ? doc2.querySelector(`tr[data-fleet-id="${fleetId}"]`) : this._findOurRow(doc2, st));
          if (!row2 || /return|powr|zawr/i.test((row2.className || "") + " " + (row2.textContent || ""))) ok = true;
        } catch {}
        if (ok) {
          this.save({ ...st, recallTries: tries, phase: "recalled", recalledAt: Date.now() });
          log("[AIR SAVE] the fleet has been RECALLED — heading home. The attacks passed into the void.", "success");
          ThreatLog.add("RETURN", "AIR SAVE: the fleet was recalled after the attacks passed — heading home.");
        } else {
          log(`[AIR SAVE] recall not confirmed (attempt ${tries}/5) — I'll retry.`, "warn");
        }
      } finally { this._recalling = false; }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  LLM PARSER (v2.64.0) — Gemini reads what the parsers don't understand
  // ═══════════════════════════════════════════════════════════════
  // The recurring pain of this project is the markup: "unknown message markup",
  // guessing structures, five versions thrown away. The LLM gets raw HTML
  // and returns numbers — regardless of the format the fork renders them in.
  //
  // HARD RULE: the model ONLY READS. No fleet decision (rescue,
  // return, FS, in-flight miner selection) goes through the LLM — defense
  // and dispatch are deterministic and stay that way. The model feeds only
  // the yield statistics, smoothed anyway by a 20-sample percentile.
  //
  // The key: a field in the panel → GM storage. NEVER in the repo — the script is publicly
  // served via auto-update; a hardcoded key would be exposed.
  const LlmParser = {
    KEY_API: "ogamex_llm_key",
    KEY_USED: "ogamex_llm_used",     // { day: "YYYY-MM-DD", n }
    KEY_SEEN: "ogamex_llm_seen",     // hashes of already accounted-for reports
    MODEL: "gemini-2.5-flash",
    DAILY_LIMIT: 40,                  // free limit is ~1500/day; a fraction is enough for us
    TIMEOUT_MS: 25 * 1000,

    apiKey() { return (GM_getValue(this.KEY_API, "") || "").trim(); },
    enabled() { return !!this.apiKey(); },

    _usedToday() {
      try {
        const u = JSON.parse(GM_getValue(this.KEY_USED, "null"));
        const today = new Date().toISOString().slice(0, 10);
        return u?.day === today ? (u.n || 0) : 0;
      } catch { return 0; }
    },
    _bumpUsed() {
      const today = new Date().toISOString().slice(0, 10);
      GM_setValue(this.KEY_USED, JSON.stringify({ day: today, n: this._usedToday() + 1 }));
    },

    // A simple hash — to tell already-counted reports from new ones.
    _hash(t) {
      let h = 0;
      for (let i = 0; i < t.length; i++) { h = ((h << 5) - h + t.charCodeAt(i)) | 0; }
      return String(h);
    },
    _seen() { try { return JSON.parse(GM_getValue(this.KEY_SEEN, "[]")); } catch { return []; } },
    _markSeen(ids) {
      const all = [...new Set([...this._seen(), ...ids])].slice(-300);
      GM_setValue(this.KEY_SEEN, JSON.stringify(all));
    },

    _call(prompt) {
      return new Promise((resolve) => {
        const body = JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // v2.64.1: thinkingBudget 0 — for pulling numbers out of HTML, the model's "thinking"
          // adds nothing, and on the paid tier it counts as output tokens
          // (the most expensive). A shorter response = lower cost and latency.
          generationConfig: { temperature: 0, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
        });
        GM_xmlhttpRequest({
          method: "POST",
          url: `https://generativelanguage.googleapis.com/v1beta/models/${this.MODEL}:generateContent?key=${encodeURIComponent(this.apiKey())}`,
          headers: { "Content-Type": "application/json" },
          data: body,
          timeout: this.TIMEOUT_MS,
          onload: (res) => {
            try {
              const j = JSON.parse(res.responseText);
              const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
              resolve(txt ? JSON.parse(txt) : null);
            } catch { resolve(null); }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      });
    },

    // ── v2.66.0: a second pair of eyes for defense — ESCALATION ONLY ──
    // Called only when the deterministic classification says "foreign fleets are present,
    // but none is an attack". The model may then RAISE the alarm (a false
    // alarm costs two flights), but it never lowers it and never
    // moves a fleet — an answer of "not an attack" changes nothing.
    KEY_DEF_SEEN: "ogamex_llm_def_seen",
    async classifyThreat(rowsHtml, signature) {
      if (!this.enabled()) return null;
      if (this._usedToday() >= this.DAILY_LIMIT) return null;
      let seen = [];
      try { seen = JSON.parse(GM_getValue(this.KEY_DEF_SEEN, "[]")); } catch {}
      if (seen.includes(signature)) return null;   // this image was already assessed
      GM_setValue(this.KEY_DEF_SEEN, JSON.stringify([...seen, signature].slice(-40)));
      this._bumpUsed();
      const out = await this._call(
        "Below are rows from the fleet movement list in an OGame-type game. These are FOREIGN fleets "
        + "flying toward the player. Assess whether ANY of these missions could be a hostile "
        + "attack on the player (attack, missiles, moon destruction). Espionage and trading "
        + "are NOT an attack. Return only JSON: {\"attack\":true/false,\"target\":\"g:s:p or null\",\"why\":\"short\"}.\n\nHTML:\n"
        + String(rowsHtml || "").replace(/\s+/g, " ").slice(0, 12000)
      );
      if (!out || typeof out.attack !== "boolean") return null;
      return out;
    },

    // Journal/message HTML → [{id, resources}] for mining missions.
    // Returns the number of NEWLY saved yield samples (0 = nothing new / failure).
    async extractYields(html, sourceLabel) {
      if (!this.enabled()) return 0;
      if (this._usedToday() >= this.DAILY_LIMIT) return 0;
      const trimmed = String(html || "").replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/\s+/g, " ").slice(0, 28000);
      if (trimmed.length < 100) return 0;
      // A source throttle: the same HTML doesn't go to the model twice.
      const pageHash = `page:${this._hash(trimmed)}`;
      if (this._seen().includes(pageHash)) return 0;
      this._bumpUsed();
      const out = await this._call(
        "Below is HTML from the mission journal of a browser game (an OGame fork). "
        + "List ALL reports from asteroid mining expeditions (asteroid mining), "
        + "that contain collected resources. For each, calculate the SUM of metal+crystal+deuterium. "
        + "Return only JSON: {\"reports\":[{\"id\":\"<date or unique fragment>\",\"resources\":<number>}]}. "
        + "Numbers in the game use dots/spaces as thousands separators. "
        + "Skip combat, espionage and expedition reports. If there is nothing: {\"reports\":[]}.\n\nHTML:\n" + trimmed
      );
      if (!out || !Array.isArray(out.reports)) {
        log(`[LLM] ${sourceLabel}: the model did not return valid JSON — sticking with the old parsers.`, "warn");
        return 0;
      }
      const seen = this._seen();
      const fresh = [];
      for (const r of out.reports) {
        const res = Number(r?.resources);
        if (!Number.isFinite(res) || res <= 0 || res > 1e18) continue;
        const id = `rep:${this._hash(String(r.id || "") + "|" + res)}`;
        if (seen.includes(id)) continue;
        fresh.push({ id, res });
      }
      this._markSeen([pageHash, ...fresh.map(f => f.id)]);
      for (const f of fresh) AsteroidYieldTracker.recordYield(f.res);
      if (fresh.length) log(`[LLM] ${sourceLabel}: read ${fresh.length} new yield report(s) (uses today: ${this._usedToday()}/${this.DAILY_LIMIT}).`, "success");
      return fresh.length;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  API SNIFFER (v2.45.0) — what the game REALLY uses
  // ═══════════════════════════════════════════════════════════════
  // The routes from the open-source OGameX turned out to be wrong for this server
  // (404 on eventbox, eventlist and check-target). Guessing further addresses
  // is shooting in the dark, and every shot is a 404 in the server logs.
  //
  // There is a simpler and more honest way: the game itself polls its own endpoints —
  // the mission bar refreshes without a reload, the galaxy loads more rows,
  // messages load their tabs. You just have to eavesdrop on the page's OWN requests.
  // We hook into fetch and XMLHttpRequest in the page context, note
  // the unique addresses and print them once. Zero extra traffic.
  const ApiSniffer = {
    KEY: "ogamex_seen_endpoints",
    MAX: 40,

    seen() { try { return JSON.parse(GM_getValue(this.KEY, "{}")); } catch { return {}; } },

    note(method, url) {
      try {
        const u = String(url || "");
        if (!u || /^data:|^blob:/.test(u)) return;
        const path = u.startsWith("http") ? new URL(u).pathname + (new URL(u).search ? "?…" : "") : u.split("#")[0];
        if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ico|mp3)$/i.test(path)) return;
        const key = `${method} ${path}`;
        const all = this.seen();
        if (all[key]) { all[key].n = (all[key].n || 1) + 1; GM_setValue(this.KEY, JSON.stringify(all)); return; }
        if (Object.keys(all).length >= this.MAX) return;
        all[key] = { at: Date.now(), n: 1 };
        GM_setValue(this.KEY, JSON.stringify(all));
        log(`[API SNIFFER] the game is polling: ${key}`, "info");
      } catch {}
    },

    install() {
      const w = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
      if (!w || w.__ogxSniffer) return;
      try {
        w.__ogxSniffer = true;
        const origFetch = w.fetch;
        if (typeof origFetch === "function") {
          w.fetch = function (input, init) {
            try { ApiSniffer.note((init && init.method) || "GET", typeof input === "string" ? input : input?.url); } catch {}
            return origFetch.apply(this, arguments);
          };
        }
        const origOpen = w.XMLHttpRequest?.prototype?.open;
        if (typeof origOpen === "function") {
          w.XMLHttpRequest.prototype.open = function (method, url) {
            try { ApiSniffer.note(method || "GET", url); } catch {}
            return origOpen.apply(this, arguments);
          };
        }
      } catch (e) {
        log(`[API SNIFFER] failed to hook in: ${e.message}`, "warn");
      }
    },

    dump() {
      const all = this.seen();
      const keys = Object.keys(all).sort();
      if (!keys.length) { log("[API SNIFFER] nothing caught yet — wander around the game for a while (galaxy, fleet, messages).", "warn"); return; }
      log(`[API SNIFFER] caught addresses (${keys.length}): ${keys.map(k => `${k} ×${all[k].n}`).join(" | ")}`, "error");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  //  AJAX (v2.41.0) — talking to the game through its own endpoints
  // ═══════════════════════════════════════════════════════════════
  // OGameX is open-source (lanedirt/OGameX), and its routes/web.php directly
  // lists the endpoints the game uses on its own. Until 2.39.1 the bot pretended
  // to be a human clicking in the DOM even where the game has a ready API — hence
  // the page reload on every scanned system and the guessing of the message
  // structure.
  //
  // The rule that applies to EVERY one of these endpoints: the new path must
  // be able to give up. Athena is a FORK (asteroids, Galleon, Falcon, Reaper do not
  // exist in upstream), so the response may look different from the source.
  // When an endpoint doesn't respond or answers with something unknown, we go back to the old
  // path instead of guessing.
  const Ajax = {
    KEY_TOKEN: "ogamex_csrf_token",
    // ── v2.45.0: this server DOES NOT HAVE the upstream endpoints ──
    // Test from 2026-08-02 18:31 on athena.ogamex.net:
    //   /ajax/fleet/eventbox/fetch      → 404
    //   /ajax/fleet/eventlist/fetch     → 404
    //   /ajax/fleet/dispatch/check-target → 404
    //   /ajax/galaxy                    → 200, but a plain HTML page
    //   /ajax/messages?tab=…            → 200, also an HTML page
    // The routes from lanedirt/OGameX describe a DIFFERENT version of the game. Until we know
    // the real addresses of this fork, these requests must not be repeated: it's
    // pure background traffic with no benefit, and every 404 is a trace in the server
    // logs. The gate is one-way — once disabled it stays disabled,
    // until an explicit "Test API".
    // ── v2.49.0: the ADDRESS is dead, not the whole idea ──
    // 2.45.0 disabled all API paths with one gate, because the endpoints
    // from upstream OGameX returned 404. Eavesdropping (20:56) showed that this server
    // has its own, completely different addresses — it's a .NET application, not Laravel:
    //   /home/Partial_AsteroidJournal
    //   /home/Partial_ExpeditionJournal
    //   /messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1
    //   /home/combatreport?id=<uuid>
    // One shared gate would have disabled, together with the dead addresses, these
    // live ones. So we remember WHICH address returned 404 — the rest keeps working.
    KEY_SUPPORT: "ogamex_api_dead_paths",
    // v2.61.0: addresses that responded correctly at least once. During an outage
    // (error page, .NET application restart) EVERY route can temporarily return
    // 404 — disabling permanently after one hiccup would take away defense's main
    // source (fleetmovementlist) forever, and exactly when it is
    // needed most. A proven address must not die from a single 404.
    KEY_PROVEN: "ogamex_api_proven_paths",
    _dead() { try { return JSON.parse(GM_getValue(this.KEY_SUPPORT, "{}")); } catch { return {}; } },
    _proven() { try { return JSON.parse(GM_getValue(this.KEY_PROVEN, "{}")); } catch { return {}; } },
    supported(url) {
      if (!url) return true;
      const path = String(url).split("?")[0];
      return !this._dead()[path];
    },
    markWorking(url) {
      const path = String(url).split("?")[0];
      const ok = this._proven();
      if (ok[path]) return;
      ok[path] = Date.now();
      GM_setValue(this.KEY_PROVEN, JSON.stringify(ok));
    },
    markUnsupported(url, status) {
      const path = String(url).split("?")[0];
      // Only 404/405 means "the route does not exist". 5xx / redirect /
      // timeout is a temporary glitch, not a verdict.
      if (status !== 404 && status !== 405) return;
      if (this._proven()[path]) {
        log(`[API] ${path} → ${status}, but this address already worked before — treating it as a server hiccup, NOT disabling it.`, "warn");
        return;
      }
      const dead = this._dead();
      if (dead[path]) return;
      dead[path] = { status, at: Date.now() };
      GM_setValue(this.KEY_SUPPORT, JSON.stringify(dead));
      log(`[API] ${path} → ${status}. This address does not exist on this server — I won't ask for it again. Other paths keep working.`, "warn");
    },
    resetDead() { GM_setValue(this.KEY_SUPPORT, "{}"); },

    // CSRF token: from <meta>, from a hidden field, from the global `token` variable
    // (that's how the game itself keeps it), and as a last resort from the remembered
    // `newAjaxToken` — every AJAX response of the game returns a fresh one.
    token() {
      const meta = document.querySelector("meta[name='csrf-token']")?.content;
      if (meta) return meta;
      const input = document.querySelector("input[name='_token'], input[name='token']")?.value;
      if (input) return input;
      try { if (typeof unsafeWindow !== "undefined" && unsafeWindow.token) return unsafeWindow.token; } catch {}
      try { if (typeof window !== "undefined" && window.token) return window.token; } catch {}
      // v2.44.0: the game inserts the token in inline scripts (`{{ csrf_token() }}`
      // in the templates). We look for it there before reaching for the remembered one.
      for (const sc of document.querySelectorAll("script:not([src])")) {
        const m = String(sc.textContent || "").match(/(?:_token|csrf[_-]?token|["']token["']|\btoken)\s*[:=]\s*["']([A-Za-z0-9]{20,})["']/);
        if (m) { this.remember(m[1]); return m[1]; }
      }
      return GM_getValue(this.KEY_TOKEN, "") || "";
    },

    remember(t) { if (t && typeof t === "string") GM_setValue(this.KEY_TOKEN, t); },

    // ── v2.44.0: tell WHAT responds and what doesn't ──
    // 2026-08-02 18:22 owner's log: "[GALAXY AJAX] the endpoint returned something
    // that is not JSON", and the threat readings still had the bar format —
    // i.e. ALL the new endpoints were silent, not only the galaxy. Without the HTTP
    // status and the beginning of the response you can't distinguish a 404 (the fork does not have that
    // route) from a 419 (missing CSRF token) from a redirect to login.
    async diagnose() {
      const tok = this.token();
      log(`[API TEST] CSRF token: ${tok ? `${tok.slice(0, 8)}… (${tok.length} chars)` : "MISSING — this is most likely the cause"}`, tok ? "info" : "error");
      // v2.54.0: the list trimmed down to addresses that make sense on THIS server.
      // The routes from upstream OGameX (eventbox, eventlist, check-target, /ajax/galaxy)
      // returned 404 or an HTML page — keeping them in the test would only add
      // noise and knocking on doors that don't exist.
      const probes = [
        ["GET", "/home/fleetmovementlist"],
        ["GET", "/home/Partial_AsteroidJournal"],
        ["GET", "/home/Partial_ExpeditionJournal"],
        ["GET", "/messages/messagedata?MessageCategoryType=FLEET_OTHER&page=1"],
        ["GET", "/messages/messagedata?MessageCategoryType=FLEET_EXPEDITION&page=1"],
      ];
      for (const [method, url, params] of probes) {
        try {
          const res = method === "GET"
            ? await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } })
            : await fetch(url, {
                method: "POST",
                headers: {
                  "X-Requested-With": "XMLHttpRequest",
                  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                },
                body: new URLSearchParams({ ...(params || {}), _token: tok, token: tok }).toString(),
              });
          const ct = res.headers.get("content-type") || "?";
          const txt = (await res.text()).replace(/\s+/g, " ").trim();
          // v2.49.1: for addresses that are to become a parser, the preview must be
          // long enough to show a report row in it, not just the <style>.
          const wide = /messagedata|Journal|combatreport/i.test(url);
          log(`[API TEST] ${method} ${url} → ${res.status} ${ct.split(";")[0]} :: ${txt.slice(0, wide ? 1500 : 220)}`, res.ok ? "info" : "error");
        } catch (e) {
          log(`[API TEST] ${method} ${url} → exception: ${e.message}`, "error");
        }
        await new Promise(r => setTimeout(r, 700));
      }
    },

  };

  // ═══════════════════════════════════════════════════════════════
  //  THREAT MONITOR  (v2.15.0) — someone is flying at us
  // ═══════════════════════════════════════════════════════════════
  // Stage 1 of fleet-save: DETECT and SHOUT. It never moves a ship.
  //
  // The signal was already in the codebase and unused: the mission bar reads
  // "N Missions: M Own", and inflightFleetCount() takes only M. N > M means
  // fleets are in the air that are NOT ours — an incoming attack, an
  // espionage probe, or an ally. One regex, zero extra requests.
  //
  // What it deliberately does NOT do yet: decide WHICH of those it is. A spy
  // probe is the scout before the punch, not a reason to launch 18 billion
  // miners, and getting that classification wrong is expensive in both
  // directions. So on the first sighting we DUMP the event rows (and, on a
  // galaxy page, the base row with its moon link) into the persisted log —
  // the same trick that saved us from assuming mission=15 for expeditions,
  // where the real answer turned out to be mission=1. Stage 2 (deploy
  // everything to the moon at the same coords) gets written against that
  // markup, not against a guess.
  //
  // While an alert is up: farming and expedition waves hold. Mining does NOT
  // — a mining dispatch sends miners AWAY from the planet, which is the
  // direction we want them going anyway.

  const ThreatMonitor = {
    KEY: "ogamex_threat",
    KEY_DUMPED: "ogamex_threat_markup_dumped_v2381",
    KEY_CANDIDATE: "ogamex_threat_candidate", // v2.32.0: since when we see foreign fleets
    CONFIRM_MS: 25 * 1000,                    // how long it must hold before we move the fleet
    SELF_SEND_BLIND_MS: 20 * 1000,            // how long after OUR dispatch the bar lies
    KEY_SEEN: "ogamex_threat_last_seen",      // v2.29.0: what the bar showed last
    KEY_SEEN_AT: "ogamex_threat_last_seen_at",
    // ── v2.99.1: the last AUTHORITATIVE read (bar/cache/fresh events) ──
    // KEY_SEEN_AT also stamps BLIND reads, so for measuring blindness it is
    // useless — a separate clock is needed, one that starts only when we truly
    // saw SOMETHING.
    KEY_SIGHT_AT: "ogamex_threat_sight_at",
    KEY_BLIND_NAV_AT: "ogamex_threat_blind_nav_at",
    BLIND_NAV_MS: 5 * 60 * 1000,   // this much blindness against an armed defense justifies a forced review
    _fetching: false,

    // ── v2.40.0: mission type from the server instead of bar arithmetic ──
    // Up to 2.39.1 the threat counted as “all missions minus our own".
    // That number says neither WHO is flying, nor WHY, nor WHERE TO, so six probes
    // sent to another colony looked identical to six attack waves on
    // the base — and evacuated the fleet for no reason (2026-08-02, ~12:18).
    //
    // OGameX has its own endpoints for this (routes/web.php):
    //   /ajax/fleet/eventbox/fetch  → JSON { hostile, neutral, friendly, ... }
    //   /ajax/fleet/eventlist/fetch → HTML with rows
    //                                 <tr class="eventFleet" data-mission-type="N">
    // The server counts mission types 1, 2, 6, 9, 10 as “hostile" — i.e. ESPIONAGE
    // (6) as well. That's why the bare counter isn't enough: only data-mission-type
    // from the list separates a probe from a strike.
    KEY_EVENTS: "ogamex_threat_events",
    KEY_EVENTS_DUMPED: "ogamex_eventlist_markup_dumped_v240",
    ATTACK_TYPES: [1, 2, 9, 10],   // 1 attack, 2 ACS attack, 9 moon destruction, 10 rockets
    ESPIONAGE_TYPE: 6,
    EVENT_MAX_AGE_MS: 90 * 1000,   // an older reading doesn't drive the alarm
    _evFetching: false,

    events() {
      try { return JSON.parse(GM_getValue(this.KEY_EVENTS, "null")); } catch { return null; }
    },

    // Our bodies — from the planet shortcut list present on every game page.
    // An event row whose SOURCE is ours is ours; the rest is foreign.
    ownBodies() {
      const set = new Set();
      for (const opt of document.querySelectorAll("#planetShortcutSelect option[value]")) {
        const m = String(opt.value).match(/^(PLANET|MOON)-(\d+)-(\d+)-(\d+)$/);
        if (m) set.add(`${m[2]}:${m[3]}:${m[4]}`);
      }
      if (set.size) GM_setValue("ogamex_own_bodies", JSON.stringify([...set]));
      else { try { for (const c of JSON.parse(GM_getValue("ogamex_own_bodies", "[]"))) set.add(c); } catch {} }
      return set;
    },

    async refreshEvents() {
      if (this._evFetching) return;
      this._evFetching = true;
      try {
        // ── v2.67.0: ATTACK SIMULATION (button in the panel) ──
        // The owner's worry after recalling an FS: “automatic fleet lifting
        // might not work either". Reading the code won't settle that —
        // the simulation pushes a synthetic attack on the base through the REAL
        // machinery: candidate → 25 s confirmation → alarm → autoSaveOnThreat
        // → real evacuation → once the window expires, real readings turn off
        // the alarm → auto-return. The only thing it doesn't test is parsing
        // a hostile HTML row — and that same parser read a spy probe correctly
        // on 04.08 09:49.
        {
          const simUntil = parseInt(GM_getValue("ogamex_threat_sim_until", "0")) || 0;
          if (Date.now() < simUntil) {
            // v2.87.0: the simulation attacks the FLEET DOM — that's where the fleet lives
            // and that's where the defense should practice (the old miner base was the target
            // from before the move).
            const b = CONFIG.expeditions?.launchFrom || CONFIG.asteroidMining.minerBase;
            GM_setValue(this.KEY_EVENTS, JSON.stringify({
              at: Date.now(), hostile: 1, attacks: 1, spies: 0, classified: true,
              targets: [`${b.galaxy}:${b.system}:${b.position}`], origins: [], sim: true,
            }));
            return;
          }
          if (simUntil) {
            GM_setValue("ogamex_threat_sim_until", "0");
            log("[TEST] attack simulation finished — defense returns to real readings. The alarm should go out shortly, and the fleet will return automatically.", "info");
          }
        }
        const hdr = { headers: { "X-Requested-With": "XMLHttpRequest" } };
        // ── v2.51.0: the real source — the fleet movements list ──
        // The row gives the mission type BY NAME (row-mission-type-ATTACK / ESPIONAGE /
        // EXPEDITION), the source, the target and the time to arrival. That closes three gaps
        // at once: a probe no longer moves the fleet, we know the attacked colony and we have
        // the attacker's composition for the journal.
        const fm = await FleetMovements.fetch().catch(() => ({ ok: false, rows: [] }));
        if (fm.ok) {
          // v2.86.2: allies (row-friendly-mission) outside ALL
          // threat counters — otherwise a buddy's stationing inflated
          // ev.hostile and the “NO classification" branch raised the alarm.
          const foreign = fm.rows.filter(r => !r.mine && !r.friendly);
          const attacks = foreign.filter(r => r.attack);
          const spies = foreign.filter(r => r.spy);
          // ── v2.88.0: EVENTS PANEL (live DOM + 3 min cache) — third source ──
          // Adds rows the list DIDN'T RETURN (13:07: an attack from the system
          // visible only as a bare bar counter — no target, ETA or body,
          // so neither blitz nor air-save could trigger). The panel's rows
          // go through the same classification as the list's rows, so target,
          // ETA and body land in the same maps — blitz and air-save work
          // automatically. Dedup by (target, kind, ETA ±20 s).
          try {
            const pRows = EventsPanel.read();
            if (pRows.length) {
              const keyOf = r => `${r.dst}|${r.attack ? "A" : "S"}|${Math.round((r.eta || 0) / 20)}`;
              const have = new Set(foreign.map(keyOf));
              let added = 0;
              for (const pr of pRows) {
                if (have.has(keyOf(pr))) continue;
                have.add(keyOf(pr));
                foreign.push(pr);
                if (pr.attack) attacks.push(pr); else if (pr.spy) spies.push(pr);
                added++;
              }
              if (added) log(`[THREAT] the Events panel added ${added} row(s) the fleet movements list didn't return.`, "warn");
            }
          } catch (e) { log(`[THREAT] Events panel: ${e.message}`, "warn"); }
          // ── v2.67.1: evidence material — raw HTML of hostile rows ──
          // Once per NEW picture of hostile fleets (not every 30 s): what
          // would be needed for a fix if the classification misread
          // a real attack. We skip probes — their reading is already confirmed.
          if (attacks.length) {
            const sigH = attacks.map(r => r.id || `${r.type}|${r.src}|${r.dst}`).sort().join(";");
            let seenH = null;
            try { seenH = JSON.parse(GM_getValue("ogamex_atk_dom_sig", "null")); } catch {}
            if (!seenH || seenH.sig !== sigH) {
              GM_setValue("ogamex_atk_dom_sig", JSON.stringify({ sig: sigH, at: Date.now() }));
              for (const r of attacks.slice(0, 3)) {
                log(`[ATTACK DOM] hostile row (${r.type}${r.unknownType ? " — TYPE OUTSIDE KNOWN LISTS" : ""}): ${r.html || "(no html)"}`, "error");
              }
              ThreatLog.add("ATTACK", `Dumped raw HTML of ${Math.min(attacks.length, 3)} hostile row(s) to the main log — material for verifying the classification.`);
            }
          }
          // ── v2.85.0: per-colony maps ──
          // • targets in order of SHORTEST ETA (the colony hit
          //   earliest is rescued first),
          // • the target body PER COLONY (until now global from the 1st row — with
          //   a mixed attack the second colony relied only on the backup
          //   fuse of an empty hangar),
          // • the set of bodies + the longest ETA per colony — the trigger
          //   and clock for recalling the AIR-SAVE.
          const byDst = new Map(); // dst -> { minEta, maxEta, bodies:Set, body }
          for (const r of attacks) {
            if (!r.dst) continue;
            const e = Number.isFinite(r.eta) && r.eta > 0 ? r.eta : 9e9;
            const rec = byDst.get(r.dst) || { minEta: Infinity, maxEta: 0, bodies: new Set(), body: null };
            if (e < rec.minEta) { rec.minEta = e; rec.body = r.dstBody || rec.body; }
            if (e !== 9e9 && e > rec.maxEta) rec.maxEta = e;
            if (r.dstBody) rec.bodies.add(r.dstBody);
            byDst.set(r.dst, rec);
          }
          const dstSorted = [...byDst.keys()].sort((a, b) => byDst.get(a).minEta - byDst.get(b).minEta);
          const out = {
            at: Date.now(),
            hostile: foreign.length,
            attacks: attacks.length,
            spies: spies.length,
            classified: true,
            targets: dstSorted,
            origins: [...new Set(attacks.map(r => r.src).filter(Boolean))],
            // v2.70.0: WHICH body the attack flies to (icon next to the target in the row) —
            // lets us not move a fleet standing on the safe side.
            // (stays global for compatibility; new readings use the maps)
            targetBody: (attacks.find(r => r.dstBody) || {}).dstBody || null,
            targetBodies: Object.fromEntries(dstSorted.filter(k => byDst.get(k).body).map(k => [k, byDst.get(k).body])),
            targetBodiesAll: Object.fromEntries(dstSorted.map(k => [k, [...byDst.get(k).bodies]])),
            targetMaxEta: Object.fromEntries(dstSorted.map(k => [k, byDst.get(k).maxEta || null])),
            // v2.70.1: the shortest attack ETA — a blitz from a neighbouring
            // system (<2 min) can't wait for full confirmation.
            minEta: attacks.length ? Math.min(...attacks.map(r => r.eta || 9e9)) : null,
          };
          // ── v2.53.0: cross-check with the mission bar ──
          // I verified /home/fleetmovementlist ONLY on our own
          // rows — nobody has flown at us since the deployment. If
          // that list shows only OUR OWN FLEETS, then v2.51.0 didn't “fix"
          // detection — it DISABLED it: foreigners always zero, the alarm never
          // rises. The mission bar counts fleets across the whole account, so a discrepancy
          // “the bar sees foreigners, the list doesn't" is the only signal we have.
          // On a discrepancy the bar wins — it knows less, but it knows for sure.
          // ── v2.66.0: Gemini as a second eye (escalation only) ──
          // Deterministics says “foreigners are here, but it's not an attack" — ask the model
          // for an independent assessment. An “attack" from the model raises the alarm candidate;
          // “not an attack" changes NOTHING.
          if (foreign.length > 0 && attacks.length === 0 && LlmParser.enabled()) {
            const sig = foreign.map(r => `${r.type}|${r.src}|${r.dst}`).sort().join(";");
            const rowsHtml = foreign.map(r => `<row type="${r.type}" from="${r.src}" to="${r.dst}" eta="${r.eta}s" ships="${(r.ships || []).join(", ")}"/>`).join("\n");
            LlmParser.classifyThreat(rowsHtml, sig).then(v => {
              if (v?.attack) {
                log(`[GEMINI] the second eye sees an ATTACK (${v.why || "no justification"}, target: ${v.target || "?"}) — raising the alarm candidate.`, "error");
                ThreatLog.add("ATTACK", `GEMINI escalation: ${v.why || ""} target ${v.target || "?"} (deterministics didn't classify the attack).`);
                const prev = { ...(this.events() || {}) };
                prev.attacks = Math.max(1, prev.attacks || 0);
                if (v.target && /^\d+:\d+:\d+$/.test(v.target)) prev.targets = [v.target];
                prev.at = Date.now();
                GM_setValue(this.KEY_EVENTS, JSON.stringify(prev));
              }
            }).catch(() => {});
          }
          const barNow = this.read();
          // v2.75.5: a discrepancy in NUMBERS, not only total blindness. 07.08
          // 08:25 the bar saw a foreigner, the list showed ONLY a probe (a
          // group attack didn't make the list or hid under a name) — the condition
          // `foreign.length === 0` didn't catch it, the probe masked the attack, the candidate
          // was cancelled and 92.8 bn ships flew without an alarm. When the bar
          // sees MORE foreigners than the list, the missing rows are an unknown —
          // and an unknown is an attack: we fall back to the bar path (25 s
          // confirmation + the blindness window after our own dispatch still work).
          if (barNow && barNow.foreign > foreign.length) {
            const warnAt = parseInt(GM_getValue("ogamex_fml_blind_warned_at", "0")) || 0;
            if (Date.now() - warnAt > 10 * 60 * 1000) {
              GM_setValue("ogamex_fml_blind_warned_at", String(Date.now()));
              log(`[THREAT] WARNING: the bar shows ${barNow.foreign} foreign fleets, but the movements list only ${foreign.length}. I treat the missing rows as an ATTACK — the defense counts from the bar.`, "error");
              // ── v2.80.3: this is an INTERMEDIATE STATE, not a verdict ──
              // Up to 2.80.2 it went out as an ERROR, i.e. a phone push with a siren.
              // 07.08 it fired three times (09:56, 11:20, 15:03) and each time
              // it was a probe that landed BETWEEN two readings:
              // the list had already removed it, the bar was still counting.
              //
              // The push added no protection here. The escalation is a line below
              // — we fall back to the bar path, which has its own 25 s
              // confirmation and on a real attack raises an ALARM with a push
              // at urgent priority. Notifying about the bare mismatch only
              // taught to ignore notifications. The entry stays in the journal,
              // the red line in the log stays — only the siren disappears.
              ThreatLog.add("reading", `Source mismatch: bar ${barNow.foreign} foreigners, list ${foreign.length}. Usually a probe that landed between readings. The defense switches to the bar and confirms for 25 s; a real attack will raise a separate ALARM.`);
            }
            // We don't stop here: we fall down to the bar path below.
          } else {
          // ── v2.75.7: THE SERVER'S VERDICT OVER OUR CLASSIFICATION ──
          // The fleet movements list could SEE an attack row but name it
          // safe (07.08 08:25 — a group attack under an unknown name, the probe
          // matched the numbers, so the bar cross-check stayed silent). The server counts
          // hostility itself, by mission type, and has different markup — if it sees more
          // attacks than we do, IT wins. A mismatch = alarm, never the other way around:
          // a missed attack costs a fleet, a false one two flights.
          const srv = await this.fetchServerEvents().catch(() => null);
          if (srv) {
            // When the server event list could be classified, only
            // srv.attacks counts — that number is already filtered by SOURCE
            // (our own flights drop out), so farming won't raise
            // the alarm. We use the raw `hostile` counter only when
            // the types couldn't be read — then everything our probes
            // don't account for is an attack.
            const srvAttacks = srv.classified
              ? srv.attacks
              : Math.max(0, (srv.hostile || 0) - out.spies);
            if (srvAttacks > out.attacks) {
              const before = out.attacks;
              out.attacks = srvAttacks;
              out.hostile = Math.max(out.hostile, srv.hostile || 0);
              for (const t of (srv.targets || [])) if (t && !out.targets.includes(t)) out.targets.push(t);
              for (const o of (srv.origins || [])) if (o && !out.origins.includes(o)) out.origins.push(o);
              const warnAt = parseInt(GM_getValue("ogamex_srv_mismatch_at", "0")) || 0;
              if (Date.now() - warnAt > 5 * 60 * 1000) {
                GM_setValue("ogamex_srv_mismatch_at", String(Date.now()));
                log(`[THREAT] SOURCE MISMATCH: the movements list gave ${before} attacks (${out.spies} probes, ${foreign.length} hostile rows), but the server sees ${srv.hostile} hostile (${srv.classified ? `${srv.attacks} attacks, ${srv.spies} probes` : "types couldn't be read"}). The server wins — raising the alarm${out.targets.length ? ` on [${out.targets.join(", ")}]` : ""}.`, "error");
                ThreatLog.add("ATTACK", `Source mismatch: movements list ${before} attacks, server ${srv.hostile} hostile fleets. Alarm from the server's verdict${out.targets.length ? ` (target: ${out.targets.join(", ")})` : " (I don't know the target — escape to the opposite body)"}.`);
              }
            }
          }
          GM_setValue(this.KEY_EVENTS, JSON.stringify(out));
          if (attacks.length) {
            const first = attacks.sort((a, b) => (a.eta || 1e9) - (b.eta || 1e9))[0];
            const mins = first.eta ? Math.max(0, Math.round(first.eta / 60)) : null;
            // v2.59.0: the defense loop runs every 30 s, so without throttling this entry
            // landed in the journal 120×/h for the whole duration of an attack — and with
            // the 600 limit it could push out the entries this journal exists for.
            // A new entry only when the picture CHANGED (count/source/target) or
            // 5 minutes passed — a continuity trace stays, spam doesn't.
            const sig = `${attacks.length}|${first.type}|${first.src}|${first.dst}`;
            let lastSig = null;
            try { lastSig = JSON.parse(GM_getValue("ogamex_threat_atk_sig", "null")); } catch {}
            if (!lastSig || lastSig.sig !== sig || Date.now() - (lastSig.at || 0) > 5 * 60 * 1000) {
              GM_setValue("ogamex_threat_atk_sig", JSON.stringify({ sig, at: Date.now() }));
              // v2.70.0: intelligence — from where (body+name) and into which body it flies.
              const bodyPl = (b, big) => b === "moon" ? (big ? "MOON" : "moon") : b === "planet" ? (big ? "PLANET" : "planet") : "?";
              ThreatLog.add("ATTACK", `${attacks.length}× ${first.type} from ${bodyPl(first.srcBody)}${first.srcName ? ` “${first.srcName}"` : ""} [${first.src}] onto ${bodyPl(first.dstBody, true)} [${first.dst}]`
                + (mins !== null ? `, arrival in ~${mins} min` : "")
                + (first.ships?.length ? ` | fleet: ${first.ships.slice(0, 8).join(", ")}` : ""));
            }
          }
          // ── v2.74.7: intelligence for NON-attacks too (probes etc.) ──
          // 06.08 12:31: a distant probe hung in the bar for minutes, raised
          // the alarm — and left NO trace in the journal (from where, with what).
          // The composition and source sit in the same tooltip as with attacks, so
          // we record every new picture of foreign missions (by signature, not every 30 s).
          const others = foreign.filter(r => !r.attack);
          if (others.length) {
            const sigS = others.map(r => r.id || `${r.type}|${r.src}|${r.dst}`).sort().join(";");
            let lastS = null;
            try { lastS = JSON.parse(GM_getValue("ogamex_threat_spy_sig", "null")); } catch {}
            if (!lastS || lastS.sig !== sigS || Date.now() - (lastS.at || 0) > 10 * 60 * 1000) {
              GM_setValue("ogamex_threat_spy_sig", JSON.stringify({ sig: sigS, at: Date.now() }));
              for (const r of others.slice(0, 3)) {
                const minsS = r.eta ? Math.max(0, Math.round(r.eta / 60)) : null;
                ThreatLog.add("reading", `Foreign mission ${r.type} from [${r.src || "?"}]${r.srcName ? ` “${r.srcName}"` : ""} onto [${r.dst || "?"}]`
                  + (minsS !== null ? `, ETA ~${minsS} min` : "")
                  + (r.ships?.length ? ` | composition: ${r.ships.slice(0, 6).join(", ")}` : ""));
              }
            }
          }
          return;
          }
        }

        const srv = await this.fetchServerEvents();
        if (!srv) return;                 // don't know → the bar stays as the fallback source
        GM_setValue(this.KEY_EVENTS, JSON.stringify(srv));
      } finally {
        this._evFetching = false;
      }
    },

    // ── v2.75.7: THE SECOND SOURCE OF TRUTH — the server events API ──
    // The classification from the fleet movements list rests on CLASS NAMES in the fork's markup.
    // 07.08 08:25 a group attack went undetected because its name wasn't on
    // any of the lists (ATTACK/SPY/SAFE), and a probe at the same time matched
    // the numbers, so the cross-check with the mission bar noticed nothing.
    // The server has its OWN hostility verdict (mission types 1,2,6,9,10) and its own
    // markup (tr.eventFleet[data-mission-type]) — an independent reading of the same
    // reality, immune to the movements list's row naming.
    // Returns null = “I don't know" (never “safe").
    async fetchServerEvents() {
      const hdr = { headers: { "X-Requested-With": "XMLHttpRequest" } };
      if (!Ajax.supported("/ajax/fleet/eventbox/fetch")) return null;
      let box = null;
      try {
        const res = await fetch("/ajax/fleet/eventbox/fetch", hdr);
        if (!res.ok) { Ajax.markUnsupported("/ajax/fleet/eventbox/fetch", res.status); return null; }
        box = await res.json();
      } catch { return null; }
      if (!box || !Number.isFinite(box.hostile)) return null;
      Ajax.remember(box.newAjaxToken); // every game response carries a fresh CSRF token
      {
        const out = { at: Date.now(), hostile: box.hostile, attacks: 0, spies: 0, classified: true, targets: [], origins: [] };
        if (box.hostile > 0) {
          let html = "";
          try {
            const res = await fetch("/ajax/fleet/eventlist/fetch", hdr);
            if (res.ok) html = await res.text();
          } catch {}
          const rows = html ? [...new DOMParser().parseFromString(html, "text/html")
            .querySelectorAll("tr.eventFleet[data-mission-type]")] : [];
          if (!rows.length) {
            // I can't classify — I don't pretend I know. The alarm goes the old way
            // (every foreign fleet = a threat), and the markup lands in the log for fixing.
            out.classified = false;
            if (html && GM_getValue(this.KEY_EVENTS_DUMPED, "") !== "1") {
              GM_setValue(this.KEY_EVENTS_DUMPED, "1");
              log(`[THREAT DOM] eventlist (${html.length}ch): ${html.replace(/\s+/g, " ").slice(0, 2000)}`, "error");
            }
          }
          const own = this.ownBodies();
          // ── v2.42.0: check whether the mission numbering is the upstream one ──
          // In this fork's galaxy link an expedition is `mission=1`, while in upstream
          // OGameX `1` means ATTACK. If the fork renumbered the missions, the whole
          // 2.40.0 classification reads hostility backwards. Our OWN rows
          // are the reference here: the bot flies expeditions, mining and transports, so
          // the type seen on our mission can't be an attack type.
          const ourTypes = new Set();
          for (const tr of rows) {
            const t = parseInt(tr.dataset.missionType || "0") || 0;
            const oc = (tr.querySelector(".coordsOrigin")?.textContent || "").match(/(\d+:\d+:\d+)/);
            if (t && oc && own.has(oc[1])) ourTypes.add(t);
          }
          const collision = this.ATTACK_TYPES.filter(t => ourTypes.has(t));
          if (collision.length) {
            out.classified = false;
            if (GM_getValue("ogamex_mission_numbering_warned", "") !== "1") {
              GM_setValue("ogamex_mission_numbering_warned", "1");
              log(`[THREAT] WARNING: our own missions have type ${collision.join(", ")}, which means attack in upstream. This server has different numbering — distinguishing a probe from an attack DISABLED, returning to the rule “every foreign fleet = a threat". Our mission types: ${[...ourTypes].join(", ")}.`, "error");
              ThreatLog.add("ERROR", `The fork's mission numbering doesn't match upstream (our types: ${[...ourTypes].join(", ")}). Classification disabled.`);
            }
          }
          const coordIn = (el, fallback) => {
            const m = String((el || fallback || "")).match(/(\d+:\d+:\d+)/);
            return m ? m[1] : null;
          };
          for (const tr of rows) {
            if (tr.dataset.returnFlight === "true") continue;   // our return
            const type = parseInt(tr.dataset.missionType || "0") || 0;
            // The SOURCE decides whose mission it is; the TARGET says which colony to evacuate.
            // You must not ask “does the row contain our coordinates" — an attack ON us
            // has our coordinates in the target and would come out as our own.
            const all = [...(tr.textContent || "").matchAll(/(\d+:\d+:\d+)/g)].map(m => m[1]);
            const origin = coordIn(tr.querySelector(".coordsOrigin")?.textContent, all[0]);
            const dest = coordIn(tr.querySelector(".destCoords")?.textContent, all[all.length - 1]);
            if (own.size && origin && own.has(origin)) continue; // our own mission
            if (!out.classified) { out.attacks = out.hostile; continue; } // numbering uncertain → treat everything as an attack
            if (type === this.ESPIONAGE_TYPE) { out.spies++; continue; }
            if (this.ATTACK_TYPES.includes(type)) {
              out.attacks++;
              if (dest) out.targets.push(dest);
              if (origin) out.origins.push(origin); // for the phalanx: where it comes from
            }
          }
        }
        return out;
      }
    },

    state() {
      try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; }
    },

    // An alert goes stale on its own: if we stop seeing foreign fleets for
    // 10 minutes the danger either landed or turned around.
    // ── v2.36.0: a missing reading is “I don't know", not “safe" ──
    // The alarm used to expire 10 minutes after the last SIGHTING of foreign fleets. The timestamp
    // refreshes only on a successful reading, so any blindness — jitter of up to
    // 15 minutes, a page without the mission bar — took the alarm down ON ITS OWN. The effect was
    // worse than no defense: an attack waited out the alarm, and auto-return pulled
    // the fleet from the refuge straight into the strike.
    //
    // The alarm is now removed ONLY by a confirmed “zero foreigners" reading (the branch
    // further down in check() that clears the state). The mere passage of time won't remove it.
    // BACKSTOP_MS exists only so that persistent blindness doesn't freeze
    // farming and expeditions forever — it's a safety fuse, not the normal path.
    BACKSTOP_MS: 3 * 60 * 60 * 1000,
    active() {
      const s = this.state();
      if (!s || !(s.count > 0)) return false;
      if (Date.now() - (s.firstAt || s.seenAt) > this.BACKSTOP_MS) return false;
      return true;
    },

    clear() { GM_setValue(this.KEY, "null"); },

    // ── v2.88.1: THE BAR PARSER — a pure function, frozen by tests ──
    // INCIDENT 12.08 15:24 (ACS on [3:272:7]): the bar showed
    // “2 Missions: 2 Hostile" — WITHOUT an “Own" segment, because no fleet of ours
    // was flying. The old regex REQUIRED “X Own", so the reading failed and the bot
    // concluded “no bar on this page" → the cache from before
    // the attack, which said “clean", came into play. The bot was blind EXACTLY when the whole
    // fleet stood at home and the attack was most dangerous: zero alarm, zero
    // push, a manual rescue by the owner. Every segment (Own/Hostile/
    // Friendly) is now OPTIONAL; an explicit “Hostile" is a hard number
    // of enemies — no subtraction arithmetic.
    parseBar(text) {
      const t = String(text || "");
      const m = t.match(/(\d+)\s*Missions?\s*:/);
      if (!m) return null;
      const total = parseInt(m[1]) || 0;
      // we read the segments from the window right after “N Missions:", so numbers from the rest
      // of the page (countdowns, coordinates) don't enter the calculation
      const win = t.slice(m.index, m.index + 160);
      const seg = (re) => { const x = win.match(re); return x ? (parseInt(x[1]) || 0) : null; };
      const own = seg(/(\d+)\s*Own/);
      const hostile = seg(/(\d+)\s*Hostile/);
      const friendly = seg(/(\d+)\s*Friendly/);
      if (own === null && hostile === null && friendly === null) return null;
      const foreign = hostile !== null ? hostile : Math.max(0, total - (own || 0) - (friendly || 0));
      return { total, own: own || 0, foreign };
    },

    // Reads the mission bar of whatever page we're on. Returns null when the
    // bar isn't rendered (most galaxy pages) so a blind page never clears a
    // live alert.
    read() {
      // ── v2.87.0: BLIND BAR SIMULATION ──
      // Reproduces the attack from 12.08 13:10: movements list and server events CLEAN,
      // only the bar sees +1 foreign fleet (that's what attacks from our own
      // system look like). The synthetic reading goes through the ENTIRE real
      // machinery: bar cache → candidate → confirmation → rescue to
      // the FLEET HOME → guard → return. It's the only way to E2E this path
      // without waiting for a real enemy.
      const blindUntil = parseInt(GM_getValue("ogamex_threat_sim_blind_until", "0")) || 0;
      if (Date.now() < blindUntil) {
        const pb0 = this.parseBar(document.body.textContent);
        const own0 = pb0 ? (pb0.own || 0) : 0;
        GM_setValue("ogamex_bar_cache", JSON.stringify({ at: Date.now(), foreign: 1, total: own0 + 1, own: own0 }));
        return { total: own0 + 1, own: own0, foreign: 1, sim: true };
      }
      if (blindUntil) {
        GM_setValue("ogamex_threat_sim_blind_until", "0");
        GM_setValue("ogamex_bar_cache", JSON.stringify({ at: Date.now(), foreign: 0, total: 0, own: 0 }));
        log("[TEST] blind bar simulation finished — the bar returns to real readings. The alarm will go out and the fleet will return automatically.", "info");
      }
      // v2.88.1: parsing lives in parseBar() — a pure function with a test matrix
      // (the 15:24 incident: a bar without an “Own" segment broke the old regex).
      const out = this.parseBar(document.body.textContent);
      if (!out) return null;
      // ── v2.86.3: THE BAR READING LEAVES A TRACE (3 min cache) ──
      // CATASTROPHE 13:10: the bar saw the attack at 13:07:42, but for the next 99 s
      // the bot spent time on galaxy pages, where the bar isn't rendered —
      // and the movements list, which DOESN'T RETURN attack rows from our own system,
      // refreshed as “clean" and wiped the picture. One log, zero
      // trace, fleet lost. Every successful bar reading (including 0 — a real
      // cancellation) is saved for 3 min and stands in for the bar where
      // it isn't there.
      GM_setValue("ogamex_bar_cache", JSON.stringify({ at: Date.now(), foreign: out.foreign, total: out.total, own: out.own }));
      return out;
    },

    // One-time markup capture so Stage 2 can be written from facts:
    // the event rows (what a hostile row looks like, its target, its ETA) and
    // the base planet's galaxy row (the moon link + its mission id).
    // v2.16.2: `force` lets the Fleet Recon button capture the events table on
    // demand, from OUR OWN fleets. Waiting for a hostile fleet to learn the
    // table's shape means Stage 2 can't be written until the day it's needed —
    // the one day nobody wants to be debugging selectors.
    // ── v2.38.0: dump the Events table from the LIVE page, not from a fetch ──
    // Fetching /ajax/fleet/eventlist returned an error page (log 09:24:21 — only CSS
    // and #error-container), so the events markup was never captured. And this
    // table IS in the DOM on the fleet page: you can see it in the owner's screenshot,
    // with rows “Yoyoyoyoyo [3:269:8] … Asteroid [3:161:17]".
    //
    // This is the markup the protection of ALL planets depends on: the mission bar
    // gives only the NUMBER of foreign fleets, never the target. Without an event row you can't
    // tell which colony needs evacuating — and guessing would move
    // the fleet blindly.
    dumpEventsFromDom() {
      if (GM_getValue(this.KEY_DUMPED, "") === "1") return;
      // v2.38.1: the selector [class*='event'] caught an SVG from a chart — the owner's
      // log ended up with `<rect class="c3-event-rect...">` instead of the events
      // table. We now search by CONTENT, like with reports from messages:
      // an event row always carries coordinates in square brackets,
      // and a chart never does. We take the DEEPEST element with at least two
      // coordinates — i.e. the events block itself, without half the page around it.
      const COORD = /\[\d+:\d+:\d+\]/g;
      const isRow = (t) => ((t || "").match(COORD) || []).length >= 2;
      // Not “deepest with coordinates" — that picks a SINGLE row instead of
      // the whole table. We want the element with the MOST coordinates (i.e.
      // covering all rows), and on a tie the shortest, to get
      // just the events block, not half the page around it.
      // v2.39.1: the planet shortcuts list ("Colony 1 [7:499:6]" ... 60 entries)
      // beat every events table on coordinate count and it was the one landing
      // in the log. An event has an arrival time and a mission type; the shortcuts list has
      // neither — and it lives in a <select>.
      const MISSION = /(attack|transport|deploy|expedition|espionage|colonis|harvest|recycl|return|destroy)/i;
      const hasClock = (t) => /\d{1,2}:\d{2}:\d{2}/.test(String(t).replace(/\[\d+:\d+:\d+\]/g, " "));
      const cand = [...document.querySelectorAll("div, table, tbody, section, ul")]
        .filter(el => {
          if (el.closest("svg") || /c3-|chart|graph/i.test(String(el.className || ""))) return false;
          if (el.tagName === "SELECT" || el.querySelector("select, option")) return false;
          const t = el.textContent || "";
          if (!(t.length <= 8000 && isRow(t))) return false;
          return hasClock(t) || MISSION.test(t);
        })
        .map(el => ({ el, n: ((el.textContent || "").match(COORD) || []).length, len: (el.textContent || "").length }))
        .sort((a, b) => (b.n - a.n) || (a.len - b.len));
      if (!cand.length) return;
      const host = cand[0].el;
      const html = (host.innerHTML || "").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\s+/g, " ").trim();
      if (html.length < 60) return;
      GM_setValue(this.KEY_DUMPED, "1");
      log(`[THREAT DOM] events block (${html.length}ch): ${html.slice(0, 2500)}`, "error");
      ThreatLog.add("reading", "Dumped the events block markup — needed to protect all planets.");
    },

    async dumpMarkupOnce(force = false) {
      if (force) GM_setValue(this.KEY_DUMPED, "");
      this.dumpEventsFromDom();
      if (GM_getValue(this.KEY_DUMPED, "") === "1" || this._fetching) return;
      this._fetching = true;
      try {
        for (const url of ["/ajax/fleet/eventlist", "/ajax/fleet/eventbox"]) {
          try {
            const res = await fetch(url, { headers: { "X-Requested-With": "XMLHttpRequest" } });
            if (!res.ok) continue;
            const txt = (await res.text()).replace(/\s+/g, " ").trim();
            if (!txt || /error-container|<style/i.test(txt.slice(0, 400))) continue; // an error page, not events
            log(`[THREAT DOM] ${url}: ${txt.slice(0, 1500)}`, "error");
            GM_setValue(this.KEY_DUMPED, "1");
            break;
          } catch {}
        }
      } finally {
        this._fetching = false;
      }
    },

    // The moon link lives in the base planet's galaxy row. Captured whenever
    // we happen to be on the base system's galaxy page — no extra navigation.
    // v2.16.2: the passive version below only fires while STANDING on the base
    // system's galaxy page — and the scanner never goes there (base [3:269],
    // asteroid ranges [3:51-160]). So the one markup Stage 2 depends on would
    // have sat uncaptured forever. Fetch it once instead: a single request,
    // ever, guarded by the same key.
    // v2.17.2: fallback when the fetch can't see the table — go there ONCE for
    // real. The scan state machine already recovers from being sent elsewhere
    // ("Scan stranded off galaxy page. Resuming at …"), so this costs one page
    // load. Only fires while nothing is in progress.
    maybeVisitBaseForMoon() {
      if (MoonSave.armed()) return false;
      if (GM_getValue("ogamex_moon_fetch_dead", "") !== "1") return false; // fetch path still has a chance
      // v2.25.0: retry with a cooldown instead of "one visit, ever". A single
      // failed visit used to close the only remaining path permanently.
      const nextTry = parseInt(GM_getValue("ogamex_moon_visit_at", "0")) || 0;
      if (Date.now() < nextTry) return false;
      GM_setValue("ogamex_moon_visit_at", String(Date.now() + 30 * 60 * 1000));
      const base = CONFIG.asteroidMining.minerBase;
      if (!base || !CONFIG.enabled) return false;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return false;
      if (ScanState.load()?.active) return false; // never interrupt a running sweep
      if (AsteroidMiner.running || InactiveFarmer.running || ExpeditionRunner.running) return false;
      log(`[MOON DOM] visiting [${base.galaxy}:${base.system}] once to read the base row (fleet-save target).`, "info");
      scanNavigate(`/galaxy?x=${base.galaxy}&y=${base.system}`, "moon recon");
      return true;
    },

    async fetchBaseRowOnce() {
      if (MoonSave.armed() || this._fetchingMoon) return;
      if (GM_getValue("ogamex_moon_fetch_dead", "") === "1") return; // proven useless here
      const base = CONFIG.asteroidMining.minerBase;
      if (!base) return;
      this._fetchingMoon = true;
      try {
        const res = await fetch(`/galaxy?x=${base.galaxy}&y=${base.system}`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
        if (!res.ok) return;
        const html = await res.text();
        if (/login|password/i.test(html.slice(0, 500))) return; // session page, not galaxy
        const doc = new DOMParser().parseFromString(html, "text/html");
        for (const item of doc.querySelectorAll(".galaxy-item")) {
          const idx = item.querySelector(".planet-index");
          if (!idx || idx.textContent.trim() !== String(base.position)) continue;
          if (GM_getValue("ogamex_moon_markup_dumped_v2253", "") !== "1") {
            GM_setValue("ogamex_moon_markup_dumped_v2253", "1");
            log(`[MOON DOM] base row [${base.galaxy}:${base.system}:${base.position}]: ${item.innerHTML.replace(/\s+/g, " ").trim().slice(0, 1200)}`, "info");
          }
          // v2.17.0: same row carries the moon link the fleet-save needs.
          MoonSave.learnFromRow(item, `${base.galaxy}:${base.system}:${base.position}`);
          MoonSave.resumeAfterLearn();
          return;
        }
        // v2.17.2: the fetched galaxy page comes back WITHOUT .galaxy-item rows
        // (the table is rendered client-side), so this path can't learn the
        // moon link at all. Count the failures, give up after two, and hand
        // over to the navigate-once fallback — the old code only set the
        // one-shot flag on SUCCESS, so it re-fetched on every scheduler tick
        // and spammed the log (seen live at 16:15:57, 16:16:00, 16:17:15).
        const tries = (parseInt(GM_getValue("ogamex_moon_fetch_tries", "0")) || 0) + 1;
        GM_setValue("ogamex_moon_fetch_tries", String(tries));
        if (tries >= 2) {
          GM_setValue("ogamex_moon_fetch_dead", "1");
          log(`[MOON DOM] fetched galaxy page has no rows (${tries} tries) — switching to a one-off visit to [${base.galaxy}:${base.system}] when the bot is idle.`, "warn");
        } else {
          log(`[MOON DOM] base row ${base.position} not found in the fetched galaxy page — the AJAX shape differs from the rendered one.`, "warn");
        }
      } catch (e) {
        log(`[MOON DOM] fetch failed: ${e.message}`, "warn");
      } finally {
        this._fetchingMoon = false;
      }
    },

    // v2.25.0: the goal is the LINK, not the dump. All three learning paths
    // used to stop at `ogamex_moon_markup_dumped_v2253 === "1"`, which is set the
    // moment the row is printed to the log — whether or not a moon link was
    // found in it. One unlucky dump therefore disabled moon-learning forever,
    // and the fleet-save button was left telling the owner to "press Fleet
    // Recon", which reads the FLEET page and can never learn a galaxy row.
    // That is the whole reason the save has been unusable.
    dumpBaseRowOnce() {
      if (MoonSave.armed()) return;
      if (GameState.getCurrentPage() !== "galaxy") return;
      const base = CONFIG.asteroidMining.minerBase;
      if (!base) return;
      const url = window.location.href;
      const gx = url.match(/[?&]x=(\d+)/);
      const sy = url.match(/[?&]y=(\d+)/);
      if (!gx || !sy || parseInt(gx[1]) !== base.galaxy || parseInt(sy[1]) !== base.system) return;
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== String(base.position)) continue;
        // Learn on EVERY visit until armed; dump the markup only once.
        if (GM_getValue("ogamex_moon_markup_dumped_v2253", "") !== "1") {
          GM_setValue("ogamex_moon_markup_dumped_v2253", "1");
          log(`[MOON DOM] base row [${base.galaxy}:${base.system}:${base.position}]: ${item.innerHTML.replace(/\s+/g, " ").trim().slice(0, 900)}`, "info");
        }
        MoonSave.learnFromRow(item, `${base.galaxy}:${base.system}:${base.position}`);
        MoonSave.resumeAfterLearn();
        return;
      }
    },

    check({ emergencyOnly = false } = {}) {
      if (!CONFIG.threatAlarm?.enabled) return;
      // These three LEARN (and the last one navigates). Skipped while the bot
      // is on a humanizer break or in the night window — the mission-bar read
      // below still runs, because that is the part an attack depends on.
      // v2.38.3: the events dump is a PURE DOM read — zero navigation, zero
      // requests. There was no reason for it to sit behind the break gate, yet it did: the owner
      // updated the bot during a 13-minute coffee break, so
      // emergencyOnly was true and the dump never ran. From the outside it looks
      // like “nothing changed".
      this.dumpEventsFromDom();
      if (!emergencyOnly) {
        this.dumpBaseRowOnce();
        this.fetchBaseRowOnce().catch(() => {}); // one-shot, no-op once captured
        this.maybeVisitBaseForMoon(); // only if the fetch path proved blind
      }

      // ── v2.40.0: the server reading takes precedence ──
      // The mission bar stays only as a fallback source: when the eventbox didn't
      // respond or when the event list can't be classified.
      const bar = this.read();
      // ── v2.86.3: a page without the bar takes the reading CACHE (3 min) ──
      // The scanner spends minutes on galaxy pages, where the bar isn't
      // rendered — until now those runs were blind to everything the
      // movements list didn't return. A reading from the last page WITH a bar lives 3 min.
      let barEff = bar;
      if (!barEff) {
        try {
          const c = JSON.parse(GM_getValue("ogamex_bar_cache", "null"));
          if (c && Date.now() - (c.at || 0) < 3 * 60 * 1000) barEff = { total: c.total || 0, own: c.own || 0, foreign: c.foreign || 0, cached: true };
        } catch {}
      }
      const ev = this.events();
      const evFresh = ev && Date.now() - ev.at < this.EVENT_MAX_AGE_MS;
      let r = barEff, evSrc = "";
      if (evFresh && ev.classified) {
        r = { total: barEff?.total ?? 0, own: barEff?.own ?? 0, foreign: ev.attacks };
        // ── v2.86.3: THE BAR WINS WHEN IT SEES MORE THAN THE LIST ──
        // CATASTROPHE 13:10: this fork's movements list DOESN'T RETURN rows
        // for attacks from our own system (3 mismatches on 12.08 — all flights
        // by Ibra646 from [2:277:11]; the last one cost the main fleet). A “clean"
        // fresh list wiped the bar reading on every pass, and the attack
        // vanished from the picture for 99 s. From now on: missing rows = ATTACK,
        // the larger number wins — on every page, cache included.
        // v2.87.3: the bar counts ALL foreign missions — PROBES TOO — so
        // comparing against only the list's attacks turned every probe into an “attack"
        // (incident 14:38-14:50: 2 probes → full rescues of empty colonies,
        // even though the list rightly said “2 probes, IGNORE"). A missing
        // row is only the bar's EXCESS over all the list's foreign rows
        // (attacks+probes) — and only that excess is treated as an attack.
        // The deadly 13:07 case (an attack not on the list at all) is still
        // covered: bar 1 > list 0 → excess 1 → alarm.
        const listForeign = Math.max(ev.hostile || 0, (ev.attacks || 0) + (ev.spies || 0));
        if (barEff && barEff.foreign > listForeign) {
          const missing = barEff.foreign - listForeign;
          r = { ...r, foreign: (ev.attacks || 0) + missing };
          evSrc = `BAR${barEff.cached ? " (cache <3 min)" : ""}: ${barEff.foreign} foreigners vs list ${listForeign} (attacks ${ev.attacks || 0}, probes ${ev.spies || 0}) — ${missing} missing treated as ATTACK`;
        } else
        evSrc = `events: attacks ${ev.attacks}${ev.spies ? `, probes ${ev.spies} (IGNORING)` : ""}`
          + (ev.targets?.length ? ` → target: ${ev.targets.join(", ")}` : "");
        // ── v2.86.1: A PROBE ARMS VIGILANCE (still doesn't move the fleet) ──
        // The opponent's full chain (owner, live 12.08): PROBE SCAN →
        // decision → attack. A probe flies in seconds and is the EARLIEST
        // signal — so for 5 min after it the defense loop drops to a rhythm
        // of ~10 s (the same mechanism as readiness after a decoy). A probe still
        // does NOT trigger evacuation: reacting with the fleet to every scan would park
        // the economy permanently and teach the attacker to steer the bot.
        if (ev.spies > 0) {
          const prev = parseInt(GM_getValue("ogamex_spy_alert_at", "0")) || 0;
          if (Date.now() - prev > 5 * 60 * 1000) {
            log(`[READINESS] spy probe (${ev.spies}) — is someone scanning us before an attack? For 5 min the defense loop runs every ~10 s.`, "warn");
          }
          GM_setValue("ogamex_spy_alert_at", String(Date.now()));
        }
      } else if (evFresh && ev.hostile > 0) {
        r = { total: barEff?.total ?? 0, own: barEff?.own ?? 0, foreign: ev.hostile };
        evSrc = `events WITHOUT classification: ${ev.hostile} foreigners (mission types couldn't be read — treating as attack)`;
      }
      // ── v2.29.0: say WHAT you actually read ──
      // 2026-08-01 23:30:20 a foreign fleet (KARAGUMRUK from [3:307:7]) flew in under
      // the owner's planet and scanned. The bot ticked at 23:30:38, :41 and :47 —
      // and didn't write a single word. You couldn't tell whether the bar showed
      // ZERO foreigners or there was no bar on that page at all, because both paths
      // were equally silent. An alarm with no reading trace is unverifiable: you
      // can't know it works until it fails on a real attack.
      // The log is throttled to one line per 10 min AND on every change,
      // so it doesn't spam and leaves evidence.
      {
        const now = Date.now();
        const seen = evSrc ? evSrc
          : r ? `${r.total} missions / ${r.own} own → ${r.foreign} foreigners`
          : "NO MISSION BAR on this page";
        const lastSeen = GM_getValue(this.KEY_SEEN, "");
        const lastAt = parseInt(GM_getValue(this.KEY_SEEN_AT, "0")) || 0;
        if (seen !== lastSeen || now - lastAt > 10 * 60 * 1000) {
          GM_setValue(this.KEY_SEEN, seen);
          GM_setValue(this.KEY_SEEN_AT, String(now));
          log(`[THREAT] reading: ${seen}${r ? "" : " (the alarm is blind on this page)"}`, r && r.foreign > 0 ? "error" : "info");
          // EVERY reading reaches the journal — including zero ones. Without proof that the bot
          // looked and saw zero, you later can't tell “didn't detect" from
          // “didn't look" — and those are two different fixes.
          // v2.86.4: an UNCONFIRMED reading is not an alarm — probes visible
          // only on the bar (Ibra646's flights) pushed a ⚔️ push with a siren at every
          // scan, and false alarms teach to ignore real ones. The ATTACK kind
          // (= push to the phone) only on a CONFIRMED alarm; until then
          // a plain reading in the journal. Confirmation (DETECTED) and blitz
          // have their own ATTACK entries — those push as before.
          ThreatLog.add(r && r.foreign > 0 ? (this.active() ? "ATTACK" : "reading") : (r ? "reading" : "BLIND"),
            `${seen}${r ? "" : ` | page: ${location.pathname}`}`);
        }
      }
      if (!r) {
        // ── v2.99.1: A BLIND ALARM GOES TO GET EYES ITSELF ──
        // Incident 20.08 03:59→04:49: after an attack (4×50 bn BC on the moon) the guard
        // exhausted its limit of 20 sweeps, and the bot stayed on /galaxy — a page without
        // the mission bar. The movements list returned nothing either, so the alarm hung
        // BLIND for 50 minutes, and only a random probe finally took it down
        // spy probe that forced a fresh read of the events. The fleet sat on
        // the refuge ~70 min longer than needed, miners didn't fly.
        // From now on: when the defense is armed (alert active or guard armed)
        // and no authoritative read has happened for BLIND_NAV_MS, the bot itself
        // navigates to "/" (overview — /overview doesn't exist on this server),
        // where the mission bar always renders. The navigation is deliberately OUTSIDE
        // the NavRateLimiter — it's the same class of traffic as rescue (visibility
        // decides the fleet), and it's throttled by its own 5-min clock. Night quiet doesn't
        // block it: the alarm was navigating anyway (rescue), blindness costs more.
        const armed = (() => { try { return !!MoonSave.watch().armed; } catch { return false; } })();
        if (this.active() || armed) {
          const sightAt = parseInt(GM_getValue(this.KEY_SIGHT_AT, "0")) || 0;
          const lastNav = parseInt(GM_getValue(this.KEY_BLIND_NAV_AT, "0")) || 0;
          const pending = GM_getValue("pending_mission", null);
          const busy = (pending && pending !== "null") || MoonSave.running;
          if (!busy && Date.now() - sightAt > this.BLIND_NAV_MS && Date.now() - lastNav > this.BLIND_NAV_MS) {
            GM_setValue(this.KEY_BLIND_NAV_AT, String(Date.now()));
            const blindMin = sightAt ? Math.round((Date.now() - sightAt) / 60000) : null;
            log(`[THREAT] defense armed, and for ${blindMin ?? "?"} min neither the bar nor events has given a read — heading to the overview for sight.`, "warn");
            ThreatLog.add("reading", `Blind for ${blindMin ?? "?"} min with armed defense — forcing an overview ("/") so the alert can clear or confirm the threat.`);
            window.location.replace("/");
          }
        }
        return; // no mission bar on this page — say nothing, change nothing
      }
      GM_setValue(this.KEY_SIGHT_AT, String(Date.now()));
      const prev = this.state();

      // ── v2.32.0: CONFIRM BEFORE MOVING THE FLEET ──
      // 2026-08-02 09:24:14 the bot sent its own expedition wave. Six seconds
      // later the bar showed "19 missions / 18 own" — one "foreign". At 09:24:20
      // a full MOON → PLANET rescue launched; at 09:24:31 the alert went out on its own
      // ("18/18 → 0 foreign"). Nobody was attacking: the game counts the sent fleet into
      // the total before adding it to "Own", so the bot saw its own ship as
      // an enemy and evacuated the whole economy. Then it tried to return and fell
      // into a loop of failed returns.
      //
      // An attack flies for minutes, so a few dozen seconds of confirmation costs nothing
      // and tells a real visitor from our own shadow:
      //   • a read within SELF_SEND_BLIND_MS of OUR dispatch is ignored
      //     (the bar is mid-update),
      //   • foreign fleets must hold for CONFIRM_MS before we raise
      //     the alert.
      const lastOwnSend = Math.max(
        parseInt(GM_getValue("ogamex_last_dispatch_at", "0")) || 0,
        (() => { try { return JSON.parse(GM_getValue("ogamex_expo_state", "null"))?.lastSendAt || 0; } catch { return 0; } })()
      );
      // v2.59.0: the blindness window applies ONLY to the bar read (the "total
      // grows before Own" artifact). The fleet-movements list read classifies by SOURCE,
      // so our own dispatch can't come out as foreign there — and expedition waves
      // go out every 60-90 s, so the bar's 20 s of blindness ate ~25% of the watch time.
      if (!evSrc && r.foreign > 0 && Date.now() - lastOwnSend < this.SELF_SEND_BLIND_MS) {
        ThreatLog.add("reading", `${r.foreign} "foreign" right after OUR dispatch (${Math.round((Date.now() - lastOwnSend) / 1000)}s) — that's our own fleet being added to the bar. Ignoring.`);
        return;
      }
      if (r.foreign > 0) {
        const pendingSince = parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0;
        // ── v2.70.1: BLITZ — a classified ATTACK with an ETA <2 min doesn't wait ──
        // The 25 s confirmation protects against the BAR artifact (own fleet
        // counted as foreign) — a classified ATTACK row from the movements list
        // doesn't have that problem, and a hunter with a moon in a neighbouring system flies
        // <60 s: full confirmation would eat the entire evacuation margin.
        // Cost of a mistake = two 81-second flights; cost of being late = the fleet.
        const blitz = evSrc && ev?.attacks > 0 && Number.isFinite(ev.minEta) && ev.minEta < 120;
        if (!pendingSince) {
          GM_setValue(this.KEY_CANDIDATE, String(Date.now()));
          // ── v2.86.0: HEIGHTENED READINESS ──
          // Enemy pattern confirmed live on 12.08: a decoy
          // (send-and-recall, candidate vanishes after 10 s) → moments later the REAL
          // attack. After every foreign-fleet sighting — including ones that
          // will vanish right away — the defense loop switches to a ~10 s rhythm for 10 minutes,
          // so a real strike doesn't wait up to 30 s to be spotted.
          if (Date.now() - (parseInt(GM_getValue("ogamex_high_alert_at", "0")) || 0) > 10 * 60 * 1000) {
            log("[READINESS] foreign fleet in sight — the defense loop will run every ~10 s for 10 min.", "warn");
          }
          GM_setValue("ogamex_high_alert_at", String(Date.now()));
          if (!blitz) {
            log(`[THREAT] seeing ${r.foreign} foreign fleet(s) for the first time — confirming for ${Math.round(this.CONFIRM_MS / 1000)}s before moving the fleet.`, "warn");
            ThreatLog.add("reading", `Alert candidate: ${r.foreign} foreign (${r.own}/${r.total}). Waiting ${Math.round(this.CONFIRM_MS / 1000)}s for confirmation.`);
            return;
          }
          log(`[THREAT] BLITZ: attack with ~${ev.minEta}s ETA — alert IMMEDIATELY, no confirmation.`, "error");
          ThreatLog.add("ATTACK", `BLITZ: ~${ev.minEta}s ETA — confirmation skipped, rescue launches right away.`);
        } else if (Date.now() - pendingSince < this.CONFIRM_MS && !blitz) {
          return; // not confirmed yet
        }
        const first = !prev || !(prev.count > 0);
        GM_setValue(this.KEY, JSON.stringify({
          count: r.foreign,
          total: r.total,
          own: r.own,
          seenAt: Date.now(),
          firstAt: first ? Date.now() : (prev.firstAt || Date.now()),
        }));
        if (first || r.foreign !== prev.count) {
          log(`INCOMING: ${r.foreign} foreign fleet(s) in the mission bar (${r.own} of ${r.total} are ours). Farming and expedition waves are on hold — CHECK THE GAME.`, "error");
          ThreatLog.add("ATTACK", `DETECTED ${r.foreign} foreign fleet(s) (${r.own} of ${r.total} are ours). Farming and expedition waves on hold.`);
          this.dumpMarkupOnce().catch(() => {});
          this.notify(r.foreign);
        }
      } else if (prev && prev.count > 0) {
        GM_setValue(this.KEY_CANDIDATE, "0");
        // ── v2.59.0: this.clear() is back in place ──
        // It fell out of here in 2.32.0 (moved to the unconfirmed-
        // candidate branch below — which is unreachable with an ACTIVE alert, because
        // this branch catches earlier). Result: after every confirmed alert
        // active() stayed true until the 3-hour BACKSTOP — the auto-return
        // from the refuge didn't fire (returnHome requires !active()), expeditions
        // and farming stood still, the guard swept the planet every 90 s, and this line
        // logged "alert cleared" every 30 s while clearing nothing.
        this.clear();
        log("Incoming fleets gone — threat alert cleared.", "success");
        ThreatLog.add("end", "Foreign fleets gone from the mission bar — alert cleared.");
      } else if (r.foreign === 0 && (parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0)) {
        // The candidate went out before confirming — exactly the case that
        // evacuated the fleet for no reason on August 2. We leave a trace in the journal.
        const held = Math.round((Date.now() - (parseInt(GM_getValue(this.KEY_CANDIDATE, "0")) || 0)) / 1000);
        GM_setValue(this.KEY_CANDIDATE, "0");
        log(`[THREAT] unconfirmed candidate vanished after ${held}s — the fleet was NOT moved.`, "info");
        ThreatLog.add("reading", `Candidate vanished after ${held}s without confirming — fleet untouched.`);
        this.clear();
      }
      updateStatusUI();
    },

    // Desktop notification if the user already granted it (we ask once, from
    // the toggle — never unprompted mid-scan).
    notify(count) {
      try {
        if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
        new Notification("OGameX: foreign fleet inbound", {
          body: `${count} foreign fleet(s) in the mission bar on ${location.host}. Check the game.`,
          tag: "ogamex-threat",
        });
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  MOON SAVE  (v2.17.0) — Stage 2 of fleet-save
  // ═══════════════════════════════════════════════════════════════
  // Lifts EVERYTHING off the base planet — every ship plus every resource —
  // onto our own moon at the same coordinates. Works because the attacker
  // picks the target when the fleet launches and cannot re-aim mid-flight:
  // planet and moon at [3:269:8] are two separate bodies. Flight is a couple
  // of minutes, so it still beats an attack landing in three.
  //
  // WHAT IS AND ISN'T AUTOMATIC, deliberately:
  //   • the SAVE itself is written and usable now, by button;
  //   • the AUTOMATIC trigger stays off until the events table has been seen,
  //     because "someone is flying at us" (mission bar: total > own) does not
  //     distinguish an attack from an espionage probe, and probes are the
  //     normal prelude to nothing. Launching the entire economy on every probe
  //     costs an hour of mining for no reason. ThreatMonitor dumps that markup
  //     on the first sighting / on demand from Fleet Recon; classification
  //     lands after, not before.
  //
  // Nothing here is guessed. The moon URL is learned from the base planet's
  // own galaxy row, exactly like the expedition link was — where the obvious
  // assumption (mission=15) turned out to be wrong (mission=1).

  // v2.20.0 — MULTI-WAVE. Owner's attacker sends several fleets in several
  // waves, and one save is not a plan against that. The hole isn't the fleet
  // we lifted; it's everything that lands on the base planet BETWEEN the
  // waves: 8 expedition waves and up to 3 mining flights come home one at a
  // time, and each one sits on the planet waiting for the next hit. So once a
  // save has been made for a live alert, a watcher keeps the planet empty
  // until the alert clears — re-running the same proven save, which aborts by
  // itself when there is nothing left to lift.
  //
  // The watcher never DECIDES that an attack is real: it only continues what
  // the first save started (button today, classifier later). That keeps the
  // probe-vs-attack question exactly where it belongs.
  //
  // Known limit, worth stating plainly: the moon is a separate target at the
  // same coords, so this dodges waves aimed at the PLANET only. An attacker
  // who splits waves between planet and moon cannot be dodged by moving
  // between them — that needs flying the fleet off-world entirely.
  const MoonSave = {
    KEY_LINK: "ogamex_moon_link",
    KEY_STATE: "ogamex_moonsave_state",
    KEY_WATCH: "ogamex_moonsave_watch",
    MIN_RESAVE_MS: 90 * 1000,   // floor between sweeps: enough for a wave to land
    MAX_SAVES_PER_ALERT: 20,    // stop rather than loop forever on a stuck alert
    running: false,

    // Candidate mission names for "fly there and STAY". The game marks the
    // choices with a class named after the mission (observed live:
    // A.mission-item.EXPEDITION, A.mission-item.ASTEROID_MINING), so we match
    // on that and log everything available when none fits — no silent wrong pick.
    // v2.26.0: owner's own screenshot of step 3 settles this — the game offers
    // Transport / Deploy / Collect, and "Deploy" is the one that flies there
    // and STAYS. It leads the list now; TRANSPORT survives only as a last
    // resort (it unloads and comes home, see the warning where it's picked).
    MISSION_CANDIDATES: ["DEPLOY", "DEPLOYMENT", "STATION", "STATIONING", "TRANSPORT"],

    link() {
      try { return JSON.parse(GM_getValue(this.KEY_LINK, "null")); } catch { return null; }
    },

    // The fleet form takes COORDINATES and lets step 2 choose planet / moon /
    // debris for them. So the target was never a link to be learned from the
    // galaxy row — it's the base's own coordinates plus a click on step 2.
    // Three releases were spent hunting a link that this build does not have.
    // ── v2.38.0: rescue works at ANY coordinates ──
    // The owner placed moons at every planet and wants an attack on
    // a colony to move its fleet to its own moon — same coords, the "moon"
    // choice, stationing mission. The mechanics are identical to the base, so
    // the only thing hard-wired was the coordinates.
    // No argument = the base, i.e. previous behaviour unchanged.
    // ── v2.87.0: RESCUE TARGET CHOICE as a PURE function ──
    // The decision that cost a fleet on 12.08 at 13:10 was hard-wired into run()
    // and untestable. Now: no DOM, network or clock — the same function
    // is called by run(), the in-browser AUTOTEST and the offline test (matrix).
    // Order: explicit target → colony guarded in this alert → (manual
    // SAVE: the operator's pair / automatic: FLEET HOME) → whatever is left.
    resolveRescueTarget({ where, watchAt, manual, fleetHome, activePair }) {
      return where || watchAt || (manual ? (activePair || fleetHome) : (fleetHome || activePair)) || null;
    },

    coordsOf(where) {
      const b = where || CONFIG.asteroidMining.minerBase;
      if (!b || !Number.isFinite(b.galaxy) || !Number.isFinite(b.system)) return null;
      return b;
    },
    targetUrl(where) {
      const b = this.coordsOf(where);
      if (!b) return null;
      return `/fleet?x=${b.galaxy}&y=${b.system}&z=${b.position}`;
    },

    // v2.28.0: which body is active right now — the one a fleet would launch
    // from, and therefore the one the ships are sitting on. The sidebar marks
    // it: a moon carries .moon-select.selected, a planet .planet-select.selected.
    // Verified live on 2026-08-01 (18:51 dump listed A.moon-select.selected
    // while the planet entry had lost its .selected class).
    // null = page has no sidebar; callers fall back rather than guess.
    // ── v2.55.0: switching to the attacked colony ──
    // The fleet form launches from the ACTIVE planet. Without this step, rescuing another
    // colony would launch the fleet FROM THE BASE (bug 2.52.0, reverted in 2.52.1).
    //
    // I don't guess the switch address: I click the colony anchor in the planet list,
    // exactly like a human would. The click works whether there's an href
    // or JS handling underneath.
    KEY_SWITCH: "ogamex_moonsave_switch",

    // Coordinates of the body currently selected in the planet list.
    activeCoords() {
      const sel = document.querySelector("a.planet-select.selected, a.moon-select.selected, .planet-select.selected, .moon-select.selected");
      const row = sel?.closest("li, div, tr") || sel?.parentElement;
      const m = String(row?.textContent || "").match(/(\d+:\d+:\d+)/);
      return m ? m[1] : null;
    },

    // Planet anchor with the given coordinates (not the moon — we launch FROM the planet).
    planetAnchor(coords) {
      for (const a of document.querySelectorAll("a.planet-select, .planet-select")) {
        const row = a.closest("li, div, tr") || a.parentElement;
        if (!row) continue;
        if (!String(row.textContent || "").includes(coords)) continue;
        return a;
      }
      return null;
    },

    // Returns true when clicked (the page reloads and the rescue resumes
    // from the remembered state). false = colony not found → we do NOT move the fleet.
    switchTo(coords, reason) {
      const a = this.planetAnchor(coords);
      if (!a) {
        log(`[RESCUE] can't find colony [${coords}] in the planet list — NOT moving the fleet. React manually.`, "error");
        ThreatLog.add("ERROR", `Colony [${coords}] is not in the planet list — evacuation aborted, fleet untouched.`);
        return false;
      }
      GM_setValue(this.KEY_SWITCH, JSON.stringify({ coords, at: Date.now(), reason: reason || "attack" }));
      log(`[RESCUE] switching to [${coords}] to launch the fleet FROM THAT colony.`, "warn");
      ThreatLog.add("RESCUE", `Switching the active planet to [${coords}] — the dispatch must launch from the attacked colony.`);
      a.click();
      return true;
    },

    // After the reload: if we're where we were supposed to be, finish the rescue.
    resumeAfterSwitch() {
      let st = null;
      try { st = JSON.parse(GM_getValue(this.KEY_SWITCH, "null")); } catch {}
      if (!st?.coords) return false;
      if (Date.now() - (st.at || 0) > 90 * 1000) { GM_setValue(this.KEY_SWITCH, "null"); return false; }
      const now = this.activeCoords();
      if (!now || now !== st.coords) return false; // not here yet — wait
      GM_setValue(this.KEY_SWITCH, "null");
      const [g, sy, pos] = st.coords.split(":").map(Number);
      log(`[RESCUE] I'm at [${st.coords}] — sending the fleet and resources to the other body.`, "warn");
      this.run({ auto: true, where: { galaxy: g, system: sy, position: pos }, reason: st.reason || "attack" })
        .catch(err => log(`[RESCUE] error after switching: ${err.message}`, "error"));
      return true;
    },

    currentBody() {
      if (document.querySelector(".moon-select.selected, a.moon-select.selected")) return "moon";
      if (document.querySelector(".planet-select.selected, a.planet-select.selected")) return "planet";
      return null;
    },
    armed() { return !!this.targetUrl(); },

    state() {
      try { return JSON.parse(GM_getValue(this.KEY_STATE, "null")) || {}; } catch { return {}; }
    },
    saveState(s) { GM_setValue(this.KEY_STATE, JSON.stringify(s)); },

    // Called with the base planet's galaxy row (from either dump path). The
    // moon column holds the link; we keep whatever the game itself points at.
    learnFromRow(rowEl, coordLabel) {
      if (this.armed() || !rowEl) return null;
      const moonCol = rowEl.querySelector(".col-moon, .galaxy-col.col-moon");
      const candidates = [
        ...(moonCol ? moonCol.querySelectorAll("a[href]") : []),
        ...rowEl.querySelectorAll("a[href*='moon'], a[href*='type=moon'], a[href*='isMoon']"),
      ];
      const a = candidates.find(el => /\/fleet/i.test(el.getAttribute("href") || ""))
             || candidates.find(el => (el.getAttribute("href") || "").length > 1);
      if (!a) {
        // v2.25.3: this used to fail SILENTLY, which is why the fleet save sat
        // "target unknown" through two visits to the base system with nothing in
        // the log to explain it. Say what was actually in the row.
        const moonCol = rowEl.querySelector(".col-moon, .galaxy-col.col-moon");
        log(`[MOON SAVE] base row found, but NO moon link. Moon column: ${moonCol ? `"${(moonCol.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 200) || "EMPTY"}"` : "no column"} | total links in the row: ${rowEl.querySelectorAll("a[href]").length}`, "warn");
        return null;
      }
      const href = a.getAttribute("href");
      const learned = { href, at: Date.now(), coord: coordLabel || null };
      GM_setValue(this.KEY_LINK, JSON.stringify(learned));
      log(`[MOON SAVE] moon target learned from the galaxy row: ${href}`, "success");
      updateStatusUI();
      return learned;
    },

    // One save per emergency. Without this the scheduler would re-fire every
    // tick and keep bouncing the fleet between planet and moon.
    recentlySaved() {
      const st = this.state();
      return !!(st.at && Date.now() - st.at < 15 * 60 * 1000);
    },

    // ── v2.21.0: the proof gate for unattended saving ──
    KEY_PROOF: "ogamex_moonsave_proven",
    proven() {
      try { return JSON.parse(GM_getValue(this.KEY_PROOF, "null")); } catch { return null; }
    },
    proveMission(name, cls) {
      if (this.proven()?.name === name) return;
      GM_setValue(this.KEY_PROOF, JSON.stringify({ name, cls, at: Date.now() }));
      log(`[MOON SAVE] stationing mission confirmed live: ${name} (${cls}). Automatic rescue is now armed.`, "success");
      updateStatusUI();
    },

    // Where the fleet goes home to. The moon href is LEARNED from the galaxy
    // row; the planet side is the base coords with planet=1 — the same shape
    // the farm module has been sending on for months, so it isn't a guess
    // either. The mission is picked on step 3 exactly like the outbound save.
    homeUrl(where) {
      return this.targetUrl(where); // step 2 picks the body; same coords
    },

    // v2.25.0: the button used to dead-end on "press Fleet Recon first" —
    // advice that cannot work, because Fleet Recon reads the fleet page and
    // the moon link lives in the base system's GALAXY row. Now the button
    // fetches what it needs itself: go to that galaxy page, learn, and carry
    // on with the save the operator actually asked for.
    KEY_RESUME: "ogamex_moonsave_resume",

    async learnThenSave(reason) {
      const b = CONFIG.asteroidMining.minerBase;
      if (!b) { log("[MOON SAVE] I don't know the base planet — set it first.", "error"); return false; }
      GM_setValue(this.KEY_RESUME, JSON.stringify({ at: Date.now(), reason }));
      log(`[MOON SAVE] moon target unknown — entering galaxy [${b.galaxy}:${b.system}] to read it, then returning to finish the rescue.`, "warn");
      await AntiDetection.sleep(300 + Math.random() * 400);
      window.location.replace(`/galaxy?x=${b.galaxy}&y=${b.system}`);
      return true;
    },

    // Called right after a successful learn on the base galaxy row.
    resumeAfterLearn() {
      let r = null;
      try { r = JSON.parse(GM_getValue(this.KEY_RESUME, "null")); } catch {}
      if (!r || !this.armed()) return;
      GM_setValue(this.KEY_RESUME, "null");
      if (Date.now() - (r.at || 0) > 30 * 60 * 1000) return; // too old to be "the click"
      log("[MOON SAVE] moon target learned — finishing the rescue you asked for.", "success");
      setTimeout(() => { this.run({ manual: true, reason: r.reason || "manually (after learning the target)" }).catch(() => {}); }, 1200);
    },

    watch() {
      try { return JSON.parse(GM_getValue(this.KEY_WATCH, "null")) || {}; } catch { return {}; }
    },
    saveWatch(w) { GM_setValue(this.KEY_WATCH, JSON.stringify(w)); },
    disarm(why) {
      const w = this.watch();
      if (!w.armed) return;
      GM_setValue(this.KEY_WATCH, "null");
      log(`[MOON SAVE] guard disabled (${why}) — the planet works normally again. Saves in this alert: ${w.saves || 0}.`, "info");
      updateStatusUI();
    },

    // v2.21.0 — the automatic trigger. Fires on ANY foreign fleet, on purpose:
    // telling an attack from a probe needs the events table we still haven't
    // captured, and waiting for that means the fleet is unprotected every
    // night in the meantime. Reacting to both is the safe error, because
    // returnHome() bounds what a false alarm costs.
    async autoSaveOnThreat() {
      if (!CONFIG.enabled || !CONFIG.threatAlarm?.enabled || !CONFIG.threatAlarm?.autoSave) return false;
      if (!ThreatMonitor.active()) return false;
      if (this.watch().armed) {                  // already saving for this alert
        // The guard keeps the body empty — that IS action, but let it carry a stamp:
        // "armed without a single save" is a state we want to know about.
        const wNow = this.watch();
        if ((wNow.saves || 0) > 0) DefenceWatchdog.note(`guard active, saves: ${wNow.saves}`);
        // ── v2.78.0: THE ONLY new exit from this branch ──
        // Everything above and below stays unchanged. There used to be
        // just `return false` here — and that's exactly where a second attack on another
        // colony slipped through. Rescuing the first colony doesn't pass through this condition
        // (on the first attack `armed` is false), so this line can't
        // affect the path that works.
        if (await RescueQueue.tryNext(wNow).catch((e) => {
          log(`[QUEUE] error: ${e.message} — the first colony stays protected.`, "error");
          return false;
        })) return true;
        // ── v2.87.1: BOTH BODIES OF THE GUARDED COLONY UNDER ATTACK ──
        // Observed LIVE on 12.08 at 14:28: the guard armed after the first
        // attack (fleet evacuated to the refuge), the enemy sent a SECOND fleet at
        // the other body of the same pair — and this branch ended in a silent
        // `return false`: the air-escape gate lives in run(), which
        // an armed guard never reached. The fleet sat on
        // the refuge under an incoming strike; a manual Deploy by the owner
        // saved it. Now: both bodies of the guarded pair under attack → run() →
        // delegation to AirSave → everything into the air.
        try {
          const guardedKey = RescueQueue.str(wNow.at);
          const bodiesNow = (ThreatMonitor.events()?.targetBodiesAll || {})[guardedKey] || [];
          if (guardedKey && bodiesNow.length >= 2 && AirSave.decideFor(wNow.at) === "air") {
            log(`[ESCAPE] BOTH bodies of the guarded colony [${guardedKey}] under attack — a jump within the pair doesn't save, sending everything into the air.`, "error");
            ThreatLog.add("ATTACK", `Both bodies [${guardedKey}] under attack with the guard armed — escape into the air instead of a jump within the pair.`);
            return this.run({ auto: true, where: wNow.at, reason: `AUTO: both bodies [${guardedKey}] under attack` });
          }
        } catch (e) { log(`[ESCAPE] error checking the guarded pair: ${e.message}`, "warn"); }
        return false;
      }
      if (this.running) return false;
      // v2.25.1: neither gate REFUSES any more. Both used to abort the save —
      // the fleet stayed on the planet while the bot explained what the owner
      // should have clicked earlier. That is the wrong trade under attack: a
      // save that goes wrong costs a page load and a fleet sitting on the moon
      // instead of the planet, while not saving costs the fleet.
      if (!this.armed()) {
        this._sayOnce("nolink", "[MOON SAVE] ATTACK — I don't know the moon target yet, entering the base galaxy, reading it and saving the fleet right away.");
        ThreatLog.add("ATTACK", "The automatic trigger fires, but I don't know the target yet — entering the base galaxy for it.");
        return this.learnThenSave("AUTO: attack, target read on the fly");
      }
      if (!this.proven()) {
        this._sayOnce("noproof", "[MOON SAVE] ATTACK — nobody has confirmed the stationing mission with a manual save yet. SAVING ANYWAY and I'll print the chosen mission below. CHECK IN GAME whether the fleet is sitting on the moon.");
      }
      // ── v2.52.0: save THE colony the attack is flying at ──
      // Until 2.51.0 the evacuation always launched from the base, because the mission bar didn't give
      // the target. The fleet-movements list gives it directly, so sticking to the base is
      // now outright harmful: it would move the fleet where nothing is flying,
      // and leave the attacked colony without a response.
      const ev = ThreatMonitor.events();
      // ── v2.86.5: The blind bar path doesn't know the target — the target is the FLEET HOME ──
      // And with the full colony-switching machinery (switchTo), the same one
      // that rescued a remote colony in combat on 12.08 at 12:33. Thanks to that,
      // the rescue is a quick jump WITHIN the home pair, not a multi-minute
      // inter-colony flight from the active body (13:41: 38 min to a visible
      // planet). The list-target path — unchanged.
      let target = ev?.attacks > 0 ? (ev.targets || [])[0] : null;
      if (!target) {
        const fh = CONFIG.expeditions?.launchFrom;
        if (fh && Number.isFinite(fh.galaxy)) target = `${fh.galaxy}:${fh.system}:${fh.position}`;
      }
      let where = null;
      if (target) {
        const [g, sy, pos] = String(target).split(":").map(Number);
        if (Number.isFinite(g) && Number.isFinite(sy) && Number.isFinite(pos)) where = { galaxy: g, system: sy, position: pos };
      }
      // ── v2.52.1: WITHOUT switching the planet, `where` is dangerous ──
      // MoonSave only builds the TARGET address; the fleet form launches from the
      // currently ACTIVE planet. On an attack against another colony, 2.52.0 would
      // launch the fleet FROM THE BASE to that colony's moon — i.e. it would move
      // the fleet out of a safe place by itself. Until there's a "switch to this
      // planet" step, we only save the base, and we say the rest outright.
      // ── v2.55.0: we evacuate the body the attack is flying at ──
      // The precondition is switching to it: the form launches from the
      // ACTIVE planet, so without this step we'd move the fleet from the base (bug 2.52.0).
      if (where) {
        const b = CONFIG.asteroidMining.minerBase;
        const isBase = where.galaxy === b.galaxy && where.system === b.system && where.position === b.position;
        ThreatLog.add("ATTACK", `Attack target: [${target}]${isBase ? " (base)" : " — evacuating THAT colony"}.`);
        // ── v2.70.0: SAFE-SIDE GUARD ──
        // The attack row says WHICH body it's flying at (icon next to the target). If the fleet
        // already sits on the body OPPOSITE the attacked one, a rescue "from the active to the
        // opposite" would move it STRAIGHT UNDER THE STRIKE (e.g. an attack on the planet
        // after mining loot, when the fleet lives on the moon — moon mode
        // makes this the main scenario). Then we don't move anything.
        // v2.75.1: the guard applies on EVERY colony, not just the base —
        // during the event the fleet lives on various moons; an attack on a colony's planet
        // with the fleet on its moon must not trigger a rescue that
        // would move the fleet straight under the strike. currentBody() describes the
        // ACTIVE pair, so the comparison is authoritative only when we're on
        // the attacked colony — otherwise the decision is made by the body
        // correction on the form (it sees where the fleet really stands).
        // v2.85.0: target body PER COLONY; when BOTH bodies of the pair are under attack
        // there's no "safe side" — the guard disables itself and the decision
        // is taken over by the air escape in run().
        const atkBody = (ev?.targetBodies || {})[target] || ev?.targetBody || null;
        const pairBodies = (ev?.targetBodiesAll || {})[target] || [];
        const active = this.activeCoords();
        if (atkBody && active === target && pairBodies.length < 2) {
          const cur = this.currentBody();
          if (cur && cur !== atkBody) {
            this._sayOnce("safeside", `[RESCUE] the attack targets the ${atkBody === "moon" ? "MOON" : "PLANET"} [${target}], and the fleet sits on the ${cur === "moon" ? "moon" : "planet"} — on the safe side. NOT moving the fleet (moving would put it under the attack).`);
            ThreatLog.add("ATTACK", `Target: ${atkBody === "moon" ? "moon" : "planet"}; fleet on the opposite body — staying in place.`);
            DefenceWatchdog.note(`safe-side guard: attack at ${atkBody}, fleet on ${cur} [${target}]`);
            return false;
          }
        }
        if (active && active !== target) {
          // The click reloads the page; the rescue finishes in resumeAfterSwitch().
          if (this.switchTo(target, `AUTO: attack on [${target}]`)) return true;
          // Deliberately NOT moving the fleet — but that MUST leave a trace, otherwise
          // it looks like plain calm (the v2.76.0 watchdog).
          DefenceWatchdog.note(`colony [${target}] outside the planet list — rescue on hold, a hand is needed`);
          return false;
        }
      }
      return this.run({
        auto: true,
        where,
        reason: where ? `AUTO: attack on [${target}]` : "AUTO: foreign fleet in the mission bar",
      });
    },

    // v2.77.2: log level as a parameter. Defaults to "error" — defense decisions
    // should be red and visible. But a routine ("return will wait, because the rescue
    // is still flying") cannot be red: red during normal work teaches
    // the operator to ignore red, and then they'll miss the real one.
    _sayOnce(key, msg, level = "error") {
      this._said = this._said || {};
      if (this._said[key] && Date.now() - this._said[key] < 5 * 60 * 1000) return;
      this._said[key] = Date.now();
      log(msg, level);
    },

    // v2.21.0 — the other half. Without it a false alarm would park the
    // economy on the moon indefinitely: mining and expeditions both launch
    // from the base planet, so an empty planet earns nothing. The alert clears
    // itself 10min after the last foreign sighting; everything comes back and
    // the bot resumes on its own.
    async returnHome({ byOperator = false } = {}) {
      const w = this.watch();
      // v2.26.2: the operator's own request never needs the guard to be armed.
      // A failed return used to disarm it, which then made this button refuse
      // to try again — the fleet sat on the moon with no way back through the
      // bot at all.
      if (!byOperator && (!w.armed || !w.saves)) return false;
      if (!byOperator) {
        if (!CONFIG.threatAlarm?.autoReturn) return false;
        // v2.25.2: auto-return belongs ONLY to saves the alarm started. A save
        // the operator pressed with a clean mission bar — "I can see something
        // you can't" — would otherwise be undone within one scheduler tick,
        // because ThreatMonitor sees no foreign fleets and calls it over. The
        // bot would be overruling a human decision 90 seconds after it was
        // made. Operator-triggered saves stay until the operator says
        // otherwise (the RETURN TO BASE button).
        if (w.trigger !== "threat") return false;
        if (ThreatMonitor.active()) return false;     // still hostile — stay put
      }
      if (this.running) return false;
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return false;
      // v2.33.0: a second layer on the same loop. Even if the disarm got lost
      // somewhere again, a return sent a minute ago is on its way — the fleet no
      // longer sits on the refuge, so another attempt would hit nothing anyway
      // ("nothing on this planet to save"). One return per 5 minutes is enough.
      if (w.returning && w.returnAt) {
        const age = Date.now() - w.returnAt;
        // ── v2.35.0: end of the deadlock ──
        // The v2.33.0 gate blocked a second return for 5 minutes, but the exits
        // from the state added in v2.34.0 only work IN THE FORM — which
        // this gate wouldn't let it reach. So the state could only be cleaned up by the code
        // that was blocking it. The owner's log: "return already flying (146s ago)"
        // over and over, with the fleet long since sitting at home.
        // A planet↔moon jump at the same coords takes under a minute,
        // so a return from 3 minutes ago is simply FINISHED.
        // v2.86.5: closure window based on the real flight time (hop = 3 min as
        // before; an inter-colony return takes as long as the rescue).
        const doneAfterMs = Math.max(3 * 60 * 1000, (w.lastFlightMs || 0) + 60000);
        if (age > doneAfterMs) {
          ThreatLog.add("RETURN", `Return sent ${Math.round(age / 1000)}s ago — the flight lasted at most ~${Math.round(doneAfterMs / 60000)} min, so it's all over. Guard removed.`);
          this.disarm("return landed long ago — closing the alert");
          return false;
        }
        this._sayOnce("returning", `[RESCUE] return already flying (${Math.round(age / 1000)}s ago) — not sending a second one.`, "info");
        return false;
      }
      // ── v2.74.5: don't recall a fleet whose RESCUE is still flying ──
      // Incident 6.08 at 12:32: the alert cleared 20 s after the rescue was sent (81 s flight
      // to the same coords); the return launched right away, found the refuge EMPTY
      // and disarmed the guard — and the rescue landed a minute later on the planet
      // with nobody bringing it back. The return waits until the rescue physically
      // lands: 130 s from the dispatch/creation stamp (hop = 81 s + margin).
      if (!byOperator) {
        const ref = Math.max(w.lastSendAt || 0, w.lastAt || 0);
        // v2.86.5: landing based on the REAL flight time of the rescue (hop = 130 s
        // as before; an inter-colony flight = its time + a minute of margin).
        const landAt = ref + Math.max(130000, (w.lastFlightMs || 0) + 60000);
        if (ref && Date.now() < landAt) {
          this._sayOnce("waitland", `[RETURN] the rescue is still flying (~${Math.ceil((landAt - Date.now()) / 1000)}s to landing) — the return will wait.`, "info");
          return false;
        }
      }
      const url = this.homeUrl(w.at);
      if (!url) return false;
      this.running = true;
      try {
        // v2.28.0: home is whatever body the fleet lived on when the alert
        // started; the refuge is the other one. The return therefore has to
        // launch FROM the refuge and target HOME — both read from the watch
        // instead of being hard-wired to moon→planet.
        const home = w.homeBody || "planet";
        const refuge = w.refugeBody || (home === "moon" ? "planet" : "moon");
        GM_setValue("pending_mission", JSON.stringify({
          type: "moon_return_direct",
          moonSave: true,       // identical form handling: all ships, all resources, stationing
          moonReturn: true,
          atCoords: w.at || CONFIG.asteroidMining.minerBase,
          targetBody: home,     // …and this leg flies back to where the fleet lives
          launchBody: refuge,   // …starting from the body it fled to
          fleetUrl: url,
          step: "switch_to_body",
          timestamp: Date.now(),
        }));
        this.saveWatch({ ...w, returning: true, returnAt: Date.now() });
        // v2.79.0: defense-window stamp — dispatches stand still until the return lands
        // and the resources (fuel!) are back on the body's account.
        DefenceHold.stamp();
        const nm = (b) => (b === "moon" ? "the moon" : "the planet");
        log(`RETURN: alert over — pulling the fleet and resources from ${nm(refuge)} back to the ${home === "moon" ? "moon" : "planet"}.`, "success");
        ThreatLog.add("RETURN", `Start: ${refuge === "moon" ? "moon" : "planet"} → ${home === "moon" ? "moon" : "planet"} (${byOperator ? "manually" : "alert over"}).`);
        await AntiDetection.sleep(400 + Math.random() * 600);
        return true;
      } catch (err) {
        log(`[MOON SAVE] return failed: ${err.message}`, "error");
        return false;
      } finally {
        this.running = false;
      }
    },

    // Scheduler hook. Only ever CONTINUES a save the operator (or, later, the
    // classifier) already started; it never starts one. Re-running run() is
    // the whole detection mechanism: the save aborts itself with "nothing on
    // this planet to save" when the hangar is clean, so an empty planet costs
    // one page load and nothing else.
    MAX_ARMED_MS: 60 * 60 * 1000, // v2.34.0: circuit breaker for a stuck state

    async keepPlanetEmpty() {
      if (!CONFIG.enabled || !CONFIG.threatAlarm?.enabled) return false;
      const w = this.watch();
      if (!w.armed) return false;
      // Last line of defense against a jam: a guard armed for an hour with no
      // threat isn't an alert, it's a forgotten state. It won't unlock itself,
      // and every firing of it moves the ENTIRE fleet.
      if (w.since && Date.now() - w.since > this.MAX_ARMED_MS && !ThreatMonitor.active()) {
        ThreatLog.add("ERROR", `Guard armed for over ${Math.round(this.MAX_ARMED_MS / 60000)} min with no threat — removing as a stuck state.`);
        this.disarm("circuit breaker: armed too long with no threat");
        return false;
      }
      if (!ThreatMonitor.active()) {
        // Don't disarm out from under returnHome() — it needs the armed state
        // to know there is something on the moon to bring back.
        if (CONFIG.threatAlarm?.autoReturn) return false;
        this.disarm("foreign fleets gone from the mission bar");
        return false;
      }
      if (this.running) return false;
      if (Date.now() - (w.lastAt || 0) < this.MIN_RESAVE_MS) return false;
      if ((w.saves || 0) >= this.MAX_SAVES_PER_ALERT) {
        if (!w.capped) { this.saveWatch({ ...w, capped: true }); log(`[MOON SAVE] limit of ${this.MAX_SAVES_PER_ALERT} saves per alert reached — the guard stands. CHECK THE GAME.`, "error"); }
        return false;
      }
      ThreatLog.add("GUARD", `Sweep #${(w.saves || 0) + 1}: checking whether anything came back to the base.`);
      return this.run({ sweep: true, reason: "multi-wave guard — cleaning up the planet" });
    },

    async run({ manual = false, sweep = false, auto = false, reason = "manual", where = null, queued = false } = {}) {
      if (this.running) return false;
      if (!this.armed()) return this.learnThenSave(reason);
      // A sweep is paced by MIN_RESAVE_MS instead: the 15-minute guard exists
      // to stop a bounce loop, and under multi-wave it would block exactly the
      // re-save the returning fleets need.
      if (!manual && !sweep && !auto && this.recentlySaved()) return false;
      // ── v2.36.0: rescue PREEMPTS, it doesn't wait in the queue ──
      // It used to refuse when the shared pending_mission slot was busy — and an
      // expedition wave launches every ~70 s with mining adding its own, so the slot
      // is busy almost constantly. The slot only expires after 5 minutes. The thing that
      // should be the fastest thing in the whole program waited behind a routine that can
      // always wait.
      // Losing one expedition wave costs minutes. Losing the fleet costs
      // everything. An abandoned task leaves no mess: it's just a record
      // in pending_mission that we overwrite right away, and an unfinished form
      // dies with the navigation.
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") {
        let kind = "another task";
        try { kind = JSON.parse(pending)?.type || kind; } catch {}
        log(`[RESCUE] interrupting the running task (${kind}) — the fleet rescue has priority.`, "warn");
        ThreatLog.add("RESCUE", `Preemption: interrupted task ${kind} so we don't wait for a free slot.`);
        GM_setValue("pending_mission", null);
      }
      this.running = true;
      try {
        // v2.75.4: coordsOf(null) returns the BASE by default, so the old expression
        // `coordsOf(where) || coordsOf(watch().at)` NEVER reached for
        // watch().at — the guard's sweep on the attacked colony aimed
        // at the base (incident 06.08 at 22:18: a sweep [2:277:8] flew to [3:272:7]).
        // Order: explicit where → the alert's colony → only then the base.
        // ── v2.85.1: a targetless rescue protects the ACTIVE pair, not the old base ──
        // Live incident 12.08 at 10:56: an ACS attack on the moon [2:277:8] detected
        // from the BAR PATH (movements list without rows → where=null), and the fallback
        // sent everything from the active moon... by Deploy to [3:272:7] —
        // 1 h 25 min of flight across half the universe instead of a <1 min jump to
        // the planet of THAT pair. The fleet survived (flight = untouchability), but the guard
        // armed itself on the wrong colony and the auto-return had nothing to bring back.
        // ── v2.86.3: A TARGETLESS RESCUE DEFENDS THE FLEET HOME ──
        // CATASTROPHE 12.08 at 13:10 — loss of the main fleet at [2:277:8]:
        // Ibra646 [2:277:11] (same system, ~3 min flight) attacked, and the movements
        // list AGAIN returned no row (bar 1 foreign / list 0 → target
        // unknown). The v2.85.1 fallback "protect the active pair" hit the moon
        // of the MINERS [3:272:7], because v2.84 itself switches the active body on every
        // mining dispatch — the defense was cleaning the colony where the bot
        // WORKED instead of the one where the fleet LIVES. The last sweep
        // reached [2:277:8] 4 seconds after the strike.
        // A rescue with no known target now defends the FLEET HOME: the expedition
        // launch point (the main fleet is by definition there and the waves return there),
        // only then the active pair, and lastly minerBase.
        const fleetHome = CONFIG.expeditions?.launchFrom || null;
        // v2.87.0: target selection through a PURE function (tested with a matrix
        // offline and in the autotest) — 2.86.5 semantics unchanged: a manual
        // SAVE protects the operator's pair, a targetless automatic protects the fleet home.
        const at = this.coordsOf(this.resolveRescueTarget({
          where, watchAt: this.watch().at, manual, fleetHome, activePair: HomeBase.coords(),
        }));
        // ── v2.85.0: AIR ESCAPE — the decision BEFORE the regular rescue ──
        // Both bodies of THIS pair under attack = an evacuation within the pair moves
        // the fleet under the second strike; then (and only then) everything flies
        // by a slow Deploy to another colony. Every "no" (disabled, one
        // body, fresh failure, sweep, queue, manual SAVE) = the old,
        // combat-proven path — the regression floor is 2.84.0.
        if (!sweep && !queued && !manual) {
          const airVerdict = AirSave.decideFor(at);
          if (airVerdict === "active") {
            DefenceWatchdog.note(`air escape in progress for [${AirSave.key(at)}] — regular rescue on hold`);
            return false;
          }
          if (airVerdict === "air") {
            let maxEta = 0;
            try { maxEta = (ThreatMonitor.events()?.targetMaxEta || {})[AirSave.key(at)] || 0; } catch {}
            if (await AirSave.launch(at, reason, maxEta)) return true;
            // launch failure = markFailed recorded — we take the old path
          }
        }
        const href = this.targetUrl(at);
        // ── v2.28.0: flee to the OTHER body, not always the moon ──
        // The owner: "if the fleet sits on the moon and an attack flies at the moon, it should
        // move to the planet and vice versa" — and intends to use one or the other
        // at different times. Turns out you don't need to know what the attack targets:
        // the attacker spies and aims where it SEES the fleet, so fleeing to
        // the opposite body is right in both cases. That removes the dependency
        // on target recon that was never successfully confirmed.
        const from = this.currentBody() || "planet";
        // v2.86.5: a jump within the pair → the opposite body (as before).
        // An INTER-COLONY flight (active pair ≠ target) → aim at the target's MOON:
        // landing on the planet sits in the enemy's phalanx (the 13:41 rescue
        // clicked the planet icon and flew 38 min to a visible planet).
        const activePair = HomeBase.coords();
        const crossColony = !!(at && activePair && (activePair.galaxy !== at.galaxy || activePair.system !== at.system || activePair.position !== at.position));
        const to = crossColony ? "moon" : (from === "moon" ? "planet" : "moon");
        const w0 = this.watch();
        GM_setValue("pending_mission", JSON.stringify({
          type: "moon_save_direct",
          moonSave: true,
          sweep: !!sweep, // v2.70.3: the sweep doesn't flip over to the second body
          atCoords: at,
          targetBody: to,
          // v2.78.0: a rescue from the queue concerns ANOTHER colony, so its
          // home is the body IT stands on, not the first one's home.
          homeBody: queued ? from : (w0.homeBody || from),
          fleetUrl: href,
          step: "select_ships_direct",
          timestamp: Date.now(),
        }));
        this.saveState({ at: Date.now(), reason });
        // Arm (or re-arm) the multi-wave watcher on every save, including the
        // manual one: pressing the button once is the operator saying "we are
        // under attack", and everything that lands afterwards has to go too.
        const w = this.watch();
        const nameOf = (b) => (b === "moon" ? "MOON" : "PLANET");
        if (queued) {
          // ── v2.78.0: a rescue FROM THE QUEUE doesn't touch the first colony's guard ──
          // saveWatch() would overwrite `at`, so the return would pull back THIS colony,
          // and the first one's fleet would stay at the escape body forever — i.e.
          // the new feature would eat the old one. Instead, we add ourselves to the
          // waiting list; the promotion after the first one's return will let us into
          // the same, proven returnHome().
          RescueQueue.addPending({ at, homeBody: from, refugeBody: to, savedAt: Date.now() });
          log(`RESCUE FROM QUEUE: ${nameOf(from)} → ${nameOf(to)} at [${at.galaxy}:${at.system}:${at.position}] (${reason}). The first colony's guard untouched.`, "success");
          ThreatLog.add("RESCUE", `QUEUE: ${nameOf(from)} → ${nameOf(to)} at [${at.galaxy}:${at.system}:${at.position}] (${reason}). This colony's return will go right after the first one's.`);
        } else {
        // Remember WHO started this: the alarm may undo its own saves, nobody
        // else's. A sweep inherits the trigger of the save it continues.
        const trigger = w.trigger || (auto || ThreatMonitor.active() ? "threat" : "manual");
        // homeBody is where the fleet LIVES — recorded on the first save of an
        // alert and never overwritten by the sweeps, so the return always knows
        // where to put everything back regardless of which body it is today.
        this.saveWatch({ armed: true, trigger, homeBody: w.homeBody || from, refugeBody: to, at,
                         lastAt: Date.now(), saves: (w.saves || 0) + 1, since: w.since || Date.now() });
        DefenceHold.stamp(); // v2.79.0: a rescue in the air = silence on dispatches
        log(`FLEET RESCUE: ${nameOf(from)} → ${nameOf(to)} at the same coordinates (${reason}). All ships and all resources.`, "success");
        ThreatLog.add("RESCUE", `Start: ${nameOf(from)} → ${nameOf(to)} (${reason}). Save #${(w.saves || 0) + 1} in this alert.`);
        }
        await AntiDetection.sleep(400 + Math.random() * 600); // emergency: barely any delay
        window.location.replace(href);
        return true;
      } catch (err) {
        log(`[MOON SAVE] error: ${err.message}`, "error");
        return false;
      } finally {
        this.running = false;
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  RESCUE QUEUE (v2.78.0) — second attack on ANOTHER colony
  // ═══════════════════════════════════════════════════════════════
  // Up to 2.77.2 one alert = one colony. When the guard was already armed,
  // autoSaveOnThreat ended with `return false` and a second attack — on another
  // colony — went through with no reaction at all.
  //
  // This whole layer lives EXCLUSIVELY in that branch. On the first attack
  // `armed` is false, so the code doesn't even enter it: the first
  // rescue flies exactly the same route as the run from 7.08 10:41 (46 s from
  // detection to the fleet in the air). The new one can only fire where
  // nothing used to happen — and that's the only reason this change
  // cannot break the working defense.
  //
  // Return: the first colony's guard stays UNTOUCHED, the others land on the
  // waiting list. When the first one's return ends, instead of disarming
  // the guard we PROMOTE the next colony into the same structure — so the same,
  // proven returnHome() pulls it back, not freshly written code.
  const RescueQueue = {
    KEY: "ogamex_rescue_queue",
    MAX_COLONIES: 5,   // limit PER ALERT, counted in colonies, not in saves

    state() {
      try {
        const v = JSON.parse(GM_getValue(this.KEY, "null"));
        return (v && typeof v === "object") ? { done: v.done || [], pending: v.pending || [] } : { done: [], pending: [] };
      } catch { return { done: [], pending: [] }; }
    },
    save(st) { GM_setValue(this.KEY, JSON.stringify(st)); },

    // The end of an alert clears the list of handled colonies, but NOT the pending
    // returns — they only make sense after the alert and must survive it.
    endAlarm() {
      const st = this.state();
      if (!(st.done || []).length) return;
      st.done = [];
      this.save(st);
    },

    str(at) {
      if (!at) return null;
      if (typeof at === "string") return /^\d+:\d+:\d+$/.test(at) ? at : null;
      return Number.isFinite(at.galaxy) ? `${at.galaxy}:${at.system}:${at.position}` : null;
    },
    obj(t) {
      const m = /^(\d+):(\d+):(\d+)$/.exec(String(t || ""));
      return m ? { galaxy: +m[1], system: +m[2], position: +m[3] } : null;
    },

    // A PURE decision — no DOM, network or clock. Thanks to that, both the
    // offline test (test-kolejka.js) and the AUTOTEST in the browser check it,
    // on the same function the real alert calls.
    nextTarget({ targets, guarded, done }) {
      const skip = new Set([guarded, ...(done || [])].filter(Boolean));
      for (const t of (targets || [])) {
        if (!t || typeof t !== "string") continue;
        if (skip.has(t)) continue;
        return t;
      }
      return null;
    },

    // How many attacked colonies nobody has touched yet — a gauge for the supervisor.
    // Without it a queue failure would be INVISIBLE: a guard armed with a single
    // save looks like success even though the second colony stands without a reaction.
    unhandledCount(w) {
      try {
        if (CONFIG.threatAlarm?.rescueQueue === false) return 0;
        const ev = ThreatMonitor.events();
        if (!ev || !(ev.attacks > 0)) return 0;
        const skip = new Set([this.str(w && w.at), ...(this.state().done || [])].filter(Boolean));
        return (ev.targets || []).filter(t => t && !skip.has(t)).length;
      } catch { return 0; }
    },

    markDone(coords) {
      const st = this.state();
      if (!st.done.includes(coords)) st.done.push(coords);
      this.save(st);
    },
    addPending(entry) {
      const st = this.state();
      st.pending.push(entry);
      this.save(st);
    },

    // Called ONLY from the "guard already armed" branch.
    async tryNext(w) {
      if (CONFIG.threatAlarm?.rescueQueue === false) return false;
      const ev = ThreatMonitor.events();
      if (!ev || !(ev.attacks > 0)) return false;
      if (MoonSave.running) return false;
      const st = this.state();
      const guarded = this.str(w && w.at);
      const next = this.nextTarget({ targets: ev.targets || [], guarded, done: st.done });
      if (!next) return false;
      const at = this.obj(next);
      if (!at) return false;
      // Limit counted in COLONIES, not in saves: an alert on three colonies
      // cannot exhaust the sweep budget of the first one.
      if ((st.done || []).length >= this.MAX_COLONIES) {
        this.markDone(next);   // don't keep retrying the same one every 30 s
        log(`[QUEUE] limit of ${this.MAX_COLONIES} colonies in one alert reached — [${next}] NOT TOUCHED. CHECK THE GAME.`, "error");
        ThreatLog.add("ERROR", `Rescue queue: limit of ${this.MAX_COLONIES} colonies per alert. Colony [${next}] got NO REACTION — check the game.`);
        return false;
      }
      // The safe-side guard doesn't apply here, for the same
      // reason as with the first rescue of a foreign colony: it only applies
      // when we stand on the attacked body (`active === target`), and here, by definition,
      // we stand elsewhere. The body is taken care of by the form correction — the same one
      // that handles the first rescue of a remote colony.
      this.markDone(next);
      log(`[QUEUE] SECOND ATTACK in an ongoing alert: colony [${next}]. The first one's guard ([${guarded || "?"}]) stays untouched — I rescue THIS colony separately.`, "error");
      ThreatLog.add("ATTACK", `QUEUE: second attack on [${next}] during the alert on [${guarded || "?"}] — I am evacuating this colony too.`);
      return MoonSave.run({ auto: true, queued: true, where: at, reason: `AUTO: second attack on [${next}]` });
    },

    // ── v2.88.3: promote FRESH entries ONLY ──
    // Incident 12.08 23:00 (right after the ALERT TEST): the promotion pulled out of the queue
    // an entry [3:272:7] saved HOURS earlier (battle 15:26) — an entry of THE
    // SAME colony that had just returned, with the OPPOSITE direction
    // (home=planet, refuge=moon). The second return started moon→planet
    // and the only reason it didn't haul 10 bn ships + 9.9 tn deuterium the
    // wrong way was that the fleet landed 5 s AFTER its hangar check ("refuge
    // empty — abort"). The entry survived because its alert's return ended
    // on the abort path, which doesn't touch the queue — by design "pending must
    // survive the alert", so TTL and dedup are the only fence.
    PENDING_MAX_AGE_MS: 4 * 60 * 60 * 1000, // the alert's backstop is 3 h — an older entry no longer has its alert

    // A PURE decision (like nextTarget) — tested offline in test-kolejka.js.
    staleReason(nx, justReturned, now, maxAgeMs) {
      const at = nx && nx.at;
      const coords = typeof at === "string"
        ? (/^\d+:\d+:\d+$/.test(at) ? at : null)
        : (at && Number.isFinite(at.galaxy) ? `${at.galaxy}:${at.system}:${at.position}` : null);
      if (!coords) return "entry without coordinates";
      if (justReturned && coords === justReturned) return "this colony just returned — its fleet is already home";
      if (now - (nx.savedAt || 0) > maxAgeMs) return "entry older than 4 h — its alert expired long ago, the directions describe a stale state";
      return null;
    },

    // After the first colony's return finishes: instead of disarming the guard,
    // put the next colony from the queue into it. The return will handle it with the same
    // code that just worked.
    promoteNext(why, justReturned = null) {
      const st = this.state();
      while ((st.pending || []).length) {
        const nx = st.pending.shift();
        this.save(st);
        const coords = this.str(nx.at) || "?";
        const stale = this.staleReason(nx, justReturned, Date.now(), this.PENDING_MAX_AGE_MS);
        if (stale) {
          log(`[QUEUE] entry [${coords}] REJECTED: ${stale}. The fleet won't move per a stale direction.`, "warn");
          ThreatLog.add("reading", `QUEUE: entry [${coords}] rejected (${stale}).`);
          continue;
        }
        MoonSave.saveWatch({
          armed: true, trigger: "threat",
          homeBody: nx.homeBody, refugeBody: nx.refugeBody,
          at: nx.at,
          // lastAt = the moment THIS colony was rescued, so the "130 s to
          // land" barrier counts from the real moment, not from the moment of promotion.
          lastAt: nx.savedAt || Date.now(),
          saves: 1, since: Date.now(),
        });
        log(`[QUEUE] ${why} — taking the next colony from the queue: [${coords}]. Left: ${st.pending.length}.`, "success");
        ThreatLog.add("RETURN", `QUEUE: pulling colony [${coords}] back (${why}). Still in the queue: ${st.pending.length}.`);
        return true;
      }
      return false;
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  EXPEDITIONS  (v2.14.0) — combat fleet in timed waves to position 16
  // ═══════════════════════════════════════════════════════════════
  // Sends the combat fleet on expeditions to [base:16], split into N waves a
  // couple of minutes apart. The spacing is a SAFETY feature, not politeness:
  // fleets return one at a time, so a hunter camping the return can catch at
  // most one wave and there is a window to react before the rest lands.
  //
  // The old ExpeditionManager is gone rather than extended: it was written for
  // the pre-2.10 "pick ONE ship type" flow, had no waves, no slot accounting
  // and no UI, and loadConfig force-disabled it. Nothing to salvage.
  //
  // Deliberately reuses the proven parts:
  //   • the 3-step direct-URL dispatch (select_ships_direct) that mining and
  //     farming already use, with an `expedition: true` flag switching the
  //     three things that differ: multi-type ship fill, the holding-time
  //     select, and skipping the same-target duplicate guard (many fleets to
  //     the SAME [g:s:16] is the whole point here — see the guard's comment).
  //   • FleetRecon for the mission id, read off galaxy row 16. Asteroids are
  //     mission=12, so 15 would have been a guess.

  const ExpeditionState = {
    KEY: "ogamex_expo_state",
    load() {
      try { return JSON.parse(GM_getValue(this.KEY, "null")) || {}; } catch { return {}; }
    },
    save(s) { GM_setValue(this.KEY, JSON.stringify(s)); },
    clear() { GM_setValue(this.KEY, "null"); },
  };

  // Ships for ONE wave, computed from the LIVE fleet page (never from a stale
  // snapshot — a recon taken while the fleet is away sees an empty hangar).
  // Split = floor(available / waves), so "8 of each" becomes 8 waves of 1.
  // Heavy Cargo is a FIXED per-wave count instead: it is the farmer's tool and
  // the single biggest stack, and splitting 1.9 billion of it across waves is
  // not something to do by accident.
  // v2.16.1: wave sizes a human would actually type. floor(available/waves) on
  // a growing fleet produces 10 437 522 one day and 11 208 964 the next —
  // nobody types that, and it changes on every rebuild. Keeping two
  // significant digits gives 10 000 000 / 11 000 000: looks hand-entered AND
  // stays put while the fleet grows, stepping up only on a real change.
  // Below 100 the exact number IS the human one (you don't round 7 ships).
  function humanRoundDown(n) {
    if (!Number.isFinite(n) || n < 100) return Math.max(0, Math.floor(n));
    const factor = Math.pow(10, Math.floor(Math.log10(n)) - 1); // keep 2 sig digits
    return Math.max(1, Math.floor(n / factor) * factor);
  }

  function expeditionShipPlan(waves) {
    const cfg = CONFIG.expeditions;
    const exclude = (cfg.excludeTypes || []).map(t => String(t).toUpperCase());
    const divisor = Math.max(1, waves || 1);
    const plan = [];
    const skipped = [];
    const empty = [];
    // ── v2.16.0: wave size is FROZEN for the whole burst ──
    // It used to be recomputed from the live hangar at every wave, so each
    // wave divided what was LEFT: 80M ships over 8 waves went out as 10M,
    // 8.7M, 7.6M, 6.6M… — a decaying tail that no human produces and that
    // isn't what "split the fleet into 8" means either. Other players save a
    // fleet group and send the identical group N times; freezing the first
    // wave's numbers reproduces exactly that, and it's also simply correct.
    // v2.19.0: a burst now ENDS after `waves` sends and the next wave re-sizes.
    // The old end condition — "nothing in the air" — was unreachable in the
    // steady state it was written for: the cap equals the wave count, so the
    // moment one lands the runner sends another and the slot count never
    // reaches zero. Sizes frozen on the first ever burst were being reused
    // forever, so a growing fleet kept flying yesterday's wave.
    const frozen = ExpeditionState.load().burst;
    const sameShape = frozen && frozen.waves === divisor && frozen.sizes;
    const useFrozen = sameShape && (frozen.sent || 0) < divisor;
    // ── v2.62.0: the LAST wave of a burst takes the WHOLE hangar ──
    // The wave share is floored to 2 significant digits (humanRoundDown), so after
    // sending all the waves the hangar kept the rounding remainder —
    // with a fleet counted in billions that could be ~10% of the fleet sitting
    // useless until the burst returns (owner: 14/14 expeditions in flight,
    // and still the fleet on the planet). A burst by design commits the WHOLE fleet
    // ("fleet ÷ waves"), so the last wave closes it to zero: it takes everything
    // left of the expedition types, instead of the frozen share.
    // v2.66.7: "lastness" also counts by SLOTS, not only by the burst
    // counter. Owner (10:18, 14/14 in the air, 31 bn fighters at home):
    // the burst counter restarted when the waves changed 10→14, so his
    // "14th send" was far off while the slots were already full — the production
    // surplus (billions/h) waited in the hangar. A wave that fills the LAST free
    // expedition slot takes the whole hangar: in a saturated rotation that closes
    // the hangar to zero on every freed slot.
    const slotsNow = ExpeditionRunner.slots();
    const capNow = ExpeditionRunner.waveCap();
    const fillingLastSlot = slotsNow.live && capNow > 0 && slotsNow.used >= capNow - 1;
    const lastOfBurst = divisor === 1 || fillingLastSlot || (useFrozen && (frozen.sent || 0) >= divisor - 1);
    // ── v2.68.2: the sweep has an UPPER LIMIT — 3× the wave share per type ──
    // Incident 05.08 09:35: the burst counter read 14/14 exactly at the moment
    // the WHOLE combat fleet sat in the hangar (freshly recalled from the morning
    // FS) — and "the whole hangar" hauled 86.7 bn ships in a single expedition.
    // The sweep is to clean up the rounding REMAINDER and the production surplus
    // (a fraction of a share per wave), not the packed main fleet. Limit 3×
    // the share: the surplus disappears in the rotation (production ~0.3× the share
    // between waves), and the parked fleet stays home.
    const SWEEP_CAP_X = 3;
    // Re-sizing is only safe because the basis is the FLEET, not the hangar.
    // With 7 of 8 waves away the hangar holds an eighth of the fleet, and
    // dividing that by eight is the decaying tail v2.16.0 froze the numbers to
    // avoid. Adding back what is demonstrably out (last wave sizes × waves in
    // the air) gives the same total whenever we recompute, so ending a burst
    // no longer shrinks the next one.
    const wavesInAir = ExpeditionRunner.slots().used || 0;
    const inAir = (type) => (frozen?.sizes?.[type] || 0) * wavesInAir;

    // ── v2.37.0: a type entirely in the air does NOT vanish from the fleet ──
    // The fleet page skips types with a zero count — in the owner's log at 11:02
    // "Ships on page" was only HEAVY_CARGO and ASTEROID_MINER, because the whole
    // rest was flying. The loop walked what's in the DOM, so a type fully
    // sent out didn't exist when the burst was recomputed: share 0, it drops out of the
    // composition. And since it dropped out, its "in the air" estimate was zero too, so
    // it NEVER came back. A ratchet. Hence the vanishing Galleon and Falcon and waves
    // shrinking to Heavy Cargo alone.
    // The fleet roster remembers the last known share of each type, and the recompute
    // goes over the SUM of the DOM types and the roster.
    const roster = ExpeditionState.load().roster || {};
    const domQty = {};
    for (const el of document.querySelectorAll("[data-ship-type]")) {
      if (el.dataset.shipType) domQty[el.dataset.shipType] = parseInt(el.dataset.shipQuantity || "0") || 0;
    }
    const shares = {}; // type → intended share in the wave (this goes into the freeze)
    for (const type of [...new Set([...Object.keys(domQty), ...Object.keys(roster)])]) {
      if (exclude.includes(type.toUpperCase())) { skipped.push(type); continue; }
      const available = domQty[type] || 0;
      if (useFrozen) {
        // Trim to what's really there; a type that ran out simply
        // drops out of the burst's remaining waves instead of blocking it.
        // v2.62.0/2.68.2: the last wave sweeps the hangar, but at most 3×
        // the share — see SWEEP_CAP_X above.
        const base = frozen.sizes[type] || 0;
        const want = lastOfBurst ? Math.min(available, Math.max(base, (base || Math.ceil(available / divisor)) * SWEEP_CAP_X)) : base;
        const qty = Math.min(want, available);
        if (qty > 0) plan.push({ type, qty, available });
        else empty.push(type);
        continue;
      }
      // `share` is the share the type SHOULD contribute (fleet ÷ waves) and it's the one
      // that gets frozen; `qty` is how much the hangar can give right now. Freezing
      // a trimmed number would cement an empty hangar for the next `waves` sends.
      const fleet = available + inAir(type);
      // v2.62.0: with 1 wave there is nothing to divide — without this humanRoundDown
      // would trim the whole fleet to 2 significant digits and the remainder would stay in the hangar.
      let share = fleet > 0 ? (divisor === 1 ? fleet : Math.max(1, humanRoundDown(fleet / divisor))) : 0;
      if (share === 0 && roster[type] > 0) share = roster[type]; // the whole type is in the air
      if (share > 0) shares[type] = share;
      // v2.66.7/2.68.2: the sweeping wave takes up to 3× the share also on a FRESH
      // burst (the shares freeze normally — the following waves go back to the split).
      const qty = lastOfBurst ? Math.min(available, Math.max(share, share * SWEEP_CAP_X)) : Math.min(share, available);
      if (qty > 0) plan.push({ type, qty, available });
      else empty.push(type);
    }

    // ── v2.37.0: Heavy Cargo splits like any other ship ──
    // It used to be excluded from the split and added as a fixed number, because "it's a
    // farming tool". Farming is disabled, so HC is just another ship
    // in the wave — and a fixed number drained it at a rate independent of how much
    // of it there was (240M → 190M → 140M → 90M at 50M per wave).
    // heavyCargoPerWave > 0 stays as a deliberate override for farmers.
    const hc = Math.max(0, parseInt(cfg.heavyCargoPerWave) || 0);
    if (hc > 0) {
      const idx = plan.findIndex(p => p.type.toUpperCase() === "HEAVY_CARGO");
      if (idx >= 0) plan.splice(idx, 1);
      const available = domQty.HEAVY_CARGO || 0;
      shares.HEAVY_CARGO = hc;
      if (available > 0) plan.push({ type: "HEAVY_CARGO", qty: Math.min(hc, available), available });
    }
    // First wave of a burst: remember these numbers so every later wave of the
    // same burst is identical.
    if (!useFrozen && plan.length) {
      const st = ExpeditionState.load();
      st.burst = { waves: divisor, at: Date.now(), sent: 0, sizes: { ...shares } };
      // The roster survives bursts: a type temporarily entirely in the air will regain
      // its share at the next recompute instead of dropping out forever.
      st.roster = { ...(st.roster || {}), ...shares };
      ExpeditionState.save(st);
      const basis = wavesInAir > 0 ? ` (fleet = hangar + ${wavesInAir} wave(s) still in the air)` : "";
      log(`Expedition burst sized${basis}: ${plan.map(p => `${p.type}×${p.qty}`).join(", ")} — the next ${divisor} wave(s) are identical.`, "fleet");
    }
    if (lastOfBurst && divisor > 1 && plan.length) {
      const why = fillingLastSlot ? `filling the last free slot (${Math.min(slotsNow.used + 1, capNow)}/${capNow})` : `last wave of the burst (${divisor}/${divisor})`;
      log(`SWEEP: ${why} — wave enlarged to max ${SWEEP_CAP_X}× the share: ${plan.map(p => `${p.type}×${p.qty}`).join(", ")}. The production surplus doesn't wait, and the parked main fleet stays home.`, "fleet");
    }
    return { plan, skipped, empty, frozen: !!useFrozen };
  }

  const ExpeditionRunner = {
    running: false,
    _warned: {},

    // v2.82.0: waves fly to position 16 of the CURRENT body's system — the operator
    // changes the launch site by switching planets in the game. expeditions.base
    // stays as a deliberate, hard override (null = follow the player).
    base() {
      const b = HomeBase.expo();
      return b && Number.isFinite(b.galaxy) && Number.isFinite(b.system) ? b : null;
    },

    // Rebuild the link for OUR base system: the learned href points at
    // whichever system the bot happened to be scanning, only its mission id is
    // universal. Shape mirrors the asteroid link (no planet= param — the game
    // launches from the ACTIVE planet, which is what the miner base already is).
    fleetUrl() {
      const b = this.base();
      const link = FleetRecon.expeditionLink();
      if (!b || !link || !link.mission) return null;
      return `/fleet?x=${b.galaxy}&y=${b.system}&z=16&mission=${link.mission}`;
    },

    // Live page value wins; off the fleet page fall back to the last cache.
    slots() {
      const m = document.body.textContent.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);
      if (m) {
        GM_setValue("ogamex_expo_total_slots", m[2]);
        GM_setValue("ogamex_expo_used", m[1]);
        return { used: parseInt(m[1]), total: parseInt(m[2]), live: true };
      }
      return {
        used: parseInt(GM_getValue("ogamex_expo_used", "0")) || 0,
        total: parseInt(GM_getValue("ogamex_expo_total_slots", "0")) || 0,
        live: false,
      };
    },

    // Cap = waves the user wants, never above the game's expedition slots.
    waveCap() {
      const wanted = Math.max(1, CONFIG.expeditions.waves || 1);
      const total = this.slots().total;
      return total > 0 ? Math.min(wanted, total) : wanted;
    },

    nextWaveGapMs() {
      const cfg = CONFIG.expeditions;
      const min = Math.max(10, cfg.waveGapMinSec || 90);
      const max = Math.max(min, cfg.waveGapMaxSec || 180);
      return Math.round((min + Math.random() * (max - min)) * 1000);
    },

    // Repeat-suppressed logging — this runs every scheduler tick and the
    // "waiting for returns" state can last an hour.
    _say(key, msg, type = "info", everyMs = 15 * 60 * 1000) {
      const last = this._warned[key] || 0;
      if (Date.now() - last < everyMs) return;
      this._warned[key] = Date.now();
      log(msg, type);
    },

    sentToday() {
      const st = ExpeditionState.load();
      const today = new Date().toISOString().slice(0, 10);
      return st.day === today ? (st.sentToday || 0) : 0;
    },

    msToNextWave() {
      const st = ExpeditionState.load();
      if (!st.lastSendAt) return 0;
      const gap = st.nextGapMs || this.nextWaveGapMs();
      return Math.max(0, st.lastSendAt + gap - Date.now());
    },

    async run() {
      const cfg = CONFIG.expeditions;
      if (!CONFIG.enabled || !cfg.enabled || this.running) return;
      if (AntiDetection.isSleepTime() || Humanizer.isOnBreak()) return;
      // v2.15.0: don't put MORE fleets in the air while something hostile is
      // inbound — every wave is one more group that could land badly timed.
      // v2.79.0: the hold lasts the entire defense window (alert + guard + rescue flight),
      // not until the second when the foreign fleets vanish from the bar.
      if (!DefenceHold.allows("ekspedycje")) return;
      // v2.79.0: a wave costs fuel — the evacuation reserve is untouchable.
      if (!Fuel.allows("ekspedycje")) return;
      // A wave click navigates through 3 pages — never start one on top of a
      // mining/farm dispatch (they share the single pending_mission slot).
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return;
      if (AsteroidMiner.running || InactiveFarmer.running) return;

      this.running = true;
      try {
        const url = this.fleetUrl();
        if (!url) {
          this._say("link", "Expeditions ON but no target yet — open any Galaxy page once so the bot can read the Expedition link from row 16.", "warn");
          return;
        }

        // Wave pacing — the reason this module exists.
        const st = ExpeditionState.load();
        const gap = st.nextGapMs || this.nextWaveGapMs();
        if (st.lastSendAt && Date.now() - st.lastSendAt < gap) return;

        // Hard cap: the game's expedition slots.
        const slots = this.slots();
        // v2.16.0: nothing in the air = the previous burst is home, so the next
        // wave starts a NEW burst and re-sizes against the full hangar (which
        // now includes everything that just came back, plus anything built
        // since). While a burst is running the frozen sizes stand.
        if (slots.live && slots.used === 0) {
          const st0 = ExpeditionState.load();
          if (st0.burst) {
            delete st0.burst;
            ExpeditionState.save(st0);
            log("All expeditions home — next burst will be re-sized against the full fleet.", "fleet");
          }
        }
        const cap = this.waveCap();
        if (slots.total && slots.used >= cap) {
          this._say("slots", `Expeditions: ${slots.used}/${slots.total} in the air (cap ${cap}) — waiting for returns.`);
          return;
        }
        // Soft cap: leave fleet slots for mining / manual play.
        const fleetTotal = parseInt(GM_getValue("ogamex_fleet_total_slots", "0")) || 0;
        if (fleetTotal) {
          const free = fleetTotal - (cfg.slotReserve || 0) - inflightFleetCount();
          if (free <= 0) {
            this._say("fleetslots", `Expeditions: no fleet slot free (reserve ${cfg.slotReserve}) — waiting.`);
            return;
          }
        }

        const b = this.base();

        GM_setValue("pending_mission", JSON.stringify({
          type: "expedition_direct",
          expedition: true,
          fleetUrl: url,
          waves: Math.max(1, cfg.waves || 1),
          holdingHours: Math.max(1, cfg.holdingHours || 1),
          launchAt: b, // v2.84.0: where the wave should launch from (the form will switch the body)
          step: "select_ships_direct",
          timestamp: Date.now(),
        }));
        // Deliberately NOT RateLimiter.record(): that 20/hour pool has exactly
        // one consumer-side gate — AsteroidMiner refuses to START A SCAN when
        // canAct() is false. Mining already spends it fast (up to 14 parallel
        // flights), so charging 8+ expedition waves to the same pool would
        // starve the scanner, i.e. trade the big income (1.3B miners a flight)
        // for the small one. Expeditions are capped by something stricter
        // anyway: the game's expedition slots plus the wave gap. Total page
        // traffic stays under NavRateLimiter, which they do share.
        log(`EXPEDITION wave → [${b.galaxy}:${b.system}:16] for ${cfg.holdingHours}h (1/${cfg.waves} of the fleet, ${slots.used}/${slots.total || "?"} slots used)`, "success");
        await AntiDetection.shortDelay();
        window.location.replace(url);
      } catch (err) {
        log(`Expedition error: ${err.message}`, "error");
      } finally {
        this.running = false;
      }
    },

    // Both post-send paths land here: finishDispatch (click didn't navigate)
    // and the fleetSendSuccessfully handler in init (the usual case).
    afterSend() {
      const st = ExpeditionState.load();
      const today = new Date().toISOString().slice(0, 10);
      // v2.15.1: BOTH post-send paths can fire for the SAME wave — finishDispatch
      // runs when the click doesn't navigate, and the fleetSendSuccessfully
      // handler runs when it does. Live log showed one wave counted as #2 and
      // #3 four seconds apart. One physical send inside 15s = one wave.
      if (st.lastSendAt && Date.now() - st.lastSendAt < 15000) return;
      st.lastSendAt = Date.now();
      st.nextGapMs = this.nextWaveGapMs();
      // v2.19.0: what ends a burst. Once `waves` waves have gone out on these
      // frozen sizes the fleet is fully committed, so the next wave re-sizes
      // against the fleet (hangar + what's in the air) and picks up anything
      // built since.
      if (st.burst) st.burst.sent = (st.burst.sent || 0) + 1;
      st.sentTotal = (st.sentTotal || 0) + 1;
      st.sentToday = (st.day === today ? (st.sentToday || 0) : 0) + 1;
      st.day = today;
      ExpeditionState.save(st);
      this._warned = {};
      log(`Expedition wave sent (#${st.sentToday} today) — next in ~${Math.round(st.nextGapMs / 1000)}s.`, "success");
      // ── v2.56.0: give the page back to the scanner right away ──
      // An expedition wave takes over navigation in the middle of a scanner run, so after
      // the send the bot sits on /fleet and waits until a tick notices "Scan stranded off
      // galaxy page". In the 21:07 log that was 7 seconds per wave — at ~100 waves
      // a day that's over a quarter of an hour of downtime on the main income source.
      // We return on our own, but only when nothing else is in progress.
      try {
        const scan = ScanState.load();
        const next = scan?.active ? scan.queue?.[0] : null;
        const busy = GM_getValue("pending_mission", null) && GM_getValue("pending_mission", null) !== "null";
        const minersOut = (parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0) > Date.now();
        if (next && !busy && !minersOut && !ThreatMonitor.active()) {
          log(`Handing the page back to the scanner — returning to [${next.galaxy}:${next.system}] without waiting for a tick.`, "asteroid");
          scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "expedition→scan handoff");
        }
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET RECON  (v2.13.1, 2026-07-31)
  // ═══════════════════════════════════════════════════════════════
  // Everything the expedition module will need lives on step 1 of the fleet
  // page — and ONLY there: the ship types this planet actually has (with their
  // internal data-ship-type ids), the saved "Select fleet group" entries, and
  // the two slot counters ("Fleets: X/Y", "Expeditions: X/Y"). The bot visits
  // that page on every dispatch anyway, so instead of asking the player to
  // read markup out of devtools, we snapshot it into GM storage on each visit
  // and log a one-line summary when it CHANGES (silent otherwise — this runs
  // on every fleet page load and must not flood the log).
  //
  // Read by: the expedition composition UI (which ships to send), the wave
  // planner (how many expedition slots exist), the farmer's slot budget.

  const FleetRecon = {
    KEY: "ogamex_fleet_recon",

    snapshot() {
      try { return JSON.parse(GM_getValue(this.KEY, "null")); } catch { return null; }
    },

    // Which planet is selected in the sidebar (ships are per-planet).
    // v2.13.2: the real marker is `a.planet-select.selected` — confirmed from
    // a step-3 clickable dump ("Yoyoyoyoyo "[A.planet-select.selected]). The
    // guessed .active/.smallplanet selectors matched nothing, hence "planet ?".
    // The entry's own text is just the NAME here, so fall back to it when the
    // sidebar doesn't render coords.
    activePlanet() {
      const el = document.querySelector(
        "a.planet-select.selected, .planet-select.selected, .smallplanet.active, .planetlink.active"
      );
      if (!el) return null;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      const m = txt.match(/\[?(\d+):(\d+):(\d+)\]?/);
      return m ? `${m[1]}:${m[2]}:${m[3]}` : (txt.slice(0, 30) || null);
    },

    // ── Expedition entry point (v2.13.2) ──
    // Row 16 ("Deep space") of any galaxy page carries the Expedition link,
    // exactly like row 17 carries the asteroid one. Learn the real URL from
    // the game instead of assuming mission=15: one row-16 dump into the
    // persisted log, then cache the parsed link + mission id for the
    // expedition module.
    KEY_EXPO_LINK: "ogamex_expo_link",

    expeditionLink() {
      try { return JSON.parse(GM_getValue(this.KEY_EXPO_LINK, "null")); } catch { return null; }
    },

    learnExpeditionLink() {
      if (GameState.getCurrentPage() !== "galaxy") return null;
      if (this.expeditionLink()) return this.expeditionLink(); // learned once, it's static
      for (const item of document.querySelectorAll(".galaxy-item")) {
        const idx = item.querySelector(".planet-index");
        if (!idx || idx.textContent.trim() !== "16") continue;
        log(`[DOM] Row 16 HTML: ${item.innerHTML.replace(/\s+/g, " ").trim().slice(0, 600)}`, "fleet");
        const a = item.querySelector("a[href*='/fleet']");
        if (!a) {
          log("[EXPO] Row 16 has no /fleet link — the Expedition button is scripted; markup dumped above.", "warn");
          return null;
        }
        const href = a.getAttribute("href");
        const mission = (href.match(/[?&]mission=(\d+)/) || [])[1] || null;
        const learned = { href, mission: mission ? parseInt(mission) : null, at: Date.now() };
        GM_setValue(this.KEY_EXPO_LINK, JSON.stringify(learned));
        log(`[EXPO] Expedition link learned: ${href} (mission=${learned.mission ?? "?"})`, "success");
        return learned;
      }
      return null;
    },

    scan() {
      if (GameState.getCurrentPage() !== "fleet") return null;

      const ships = [...document.querySelectorAll("[data-ship-type]")].map(el => {
        const item = el.closest(".ship-item") || el;
        const label = (el.getAttribute("title") || item.querySelector("img")?.alt ||
                       el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        return {
          type: el.dataset.shipType,
          qty: parseInt(el.dataset.shipQuantity || "0") || 0,
          label: label.slice(0, 30),
        };
      }).filter(s => s.type);

      // "Select fleet group" — a <select> whose own options say so. Matching on
      // the placeholder option keeps us off unrelated selects (expedition
      // duration, speed, …) without depending on an id we haven't seen.
      let groups = [];
      for (const sel of document.querySelectorAll("select")) {
        const opts = [...sel.options].map(o => (o.textContent || "").replace(/\s+/g, " ").trim());
        if (!opts.some(t => /fleet\s*group/i.test(t))) continue;
        groups = [...sel.options].map(o => ({ value: o.value, text: (o.textContent || "").trim().slice(0, 40) }));
        break;
      }

      const text = document.body.textContent;
      const fm = text.match(/Fleets:\s*(\d+)\s*\/\s*(\d+)/);
      const em = text.match(/Expeditions?:\s*(\d+)\s*\/\s*(\d+)/);

      const snap = {
        at: Date.now(),
        planet: this.activePlanet(),
        ships,
        groups,
        fleetSlots: fm ? { used: parseInt(fm[1]), total: parseInt(fm[2]) } : null,
        expoSlots: em ? { used: parseInt(em[1]), total: parseInt(em[2]) } : null,
      };

      // Cache the slot totals where the existing consumers already look.
      if (snap.fleetSlots) GM_setValue("ogamex_fleet_total_slots", String(snap.fleetSlots.total));
      if (snap.expoSlots) GM_setValue("ogamex_expo_total_slots", String(snap.expoSlots.total));

      // Log only when the interesting part changed (ship TYPES, groups, slot
      // totals) — quantities move constantly and would spam every page load.
      const prev = this.snapshot();
      const fingerprint = s => s && JSON.stringify([
        s.planet,
        (s.ships || []).map(x => x.type).sort(),
        (s.groups || []).map(x => x.text),
        s.fleetSlots?.total, s.expoSlots?.total,
      ]);
      GM_setValue(this.KEY, JSON.stringify(snap));
      if (fingerprint(prev) !== fingerprint(snap)) this.logSummary(snap, "changed");
      this.homeGuard(snap);
      return snap;
    },

    // ── v2.88.1: FLEET HOME GUARD ──
    // INCIDENT 15:24: after the fleet moved, the "Expedition start" field still
    // pointed at 2:277:8 — and the blind alert from the bar defends THAT field, so
    // the defense would fly into an empty colony. The bot visits the fleet page
    // on every dispatch anyway: it records the hangar per coordinate pair and SCREAMS
    // (log + journal with a push) when the biggest fleet lives somewhere other
    // than the field. A pure alert — it doesn't move the fleet. We compare home with its
    // 48 h MAXIMUM, so a temporarily empty hangar (fleet save at night,
    // fleet in the air) doesn't raise a false alert.
    KEY_HANGARS: "ogamex_hangar_map",

    homeGuard(snap) {
      try {
        if (!snap || !snap.planet || !/^\d+:\d+:\d+$/.test(snap.planet)) return;
        let map = {}; try { map = JSON.parse(GM_getValue(this.KEY_HANGARS, "{}")) || {}; } catch { map = {}; }
        const cur = (snap.ships || []).reduce((a, sh) => a + (sh.qty || 0), 0);
        const e = map[snap.planet] || {};
        const maxFresh = (Date.now() - (e.maxAt || 0) < 48 * 60 * 60 * 1000) ? (e.max || 0) : 0;
        map[snap.planet] = cur >= maxFresh
          ? { total: cur, max: cur, maxAt: Date.now(), at: Date.now() }
          : { total: cur, max: maxFresh, maxAt: e.maxAt, at: Date.now() };
        for (const k of Object.keys(map)) if (Date.now() - (map[k].at || 0) > 48 * 60 * 60 * 1000) delete map[k];
        GM_setValue(this.KEY_HANGARS, JSON.stringify(map));
        const fh = CONFIG.expeditions?.launchFrom;
        if (!fh || !Number.isFinite(fh.galaxy)) return;
        const homeKey = `${fh.galaxy}:${fh.system}:${fh.position}`;
        const v = this.homeVerdict({ map, homeKey });
        if (!v) return;
        const KEY_AT = "ogamex_homeguard_warned_at";
        if (Date.now() - (parseInt(GM_getValue(KEY_AT, "0")) || 0) < 6 * 60 * 60 * 1000) return;
        GM_setValue(KEY_AT, String(Date.now()));
        log(`[FLEET HOME] "Expedition start" = [${homeKey}], but I see the biggest hangar at [${v.key}] (${v.total.toLocaleString()} ships vs ${v.homeMax.toLocaleString()} at home over 48 h). A blind alert from the bar defends the FIELD — fix "Expedition start" in the panel, otherwise the rescue will fly into the wrong colony.`, "error");
        ThreatLog.add("ERROR", `Fleet home ≠ real hangar: field [${homeKey}], biggest fleet at [${v.key}]. Fix "Expedition start", otherwise the blind alert defends the wrong colony.`);
      } catch {}
    },

    // pure decision (testable as a matrix): biggest hangar ≠ home field
    // + a clear margin (≥1 bn ships and ≥2× the home max over 48 h) —
    // a miners' moon (7.5 bn) next to the main fleet (hundreds of bn) does NOT alert.
    homeVerdict({ map, homeKey }) {
      const homeMax = (map[homeKey] && (map[homeKey].max || map[homeKey].total)) || 0;
      let key = null, total = 0;
      for (const k of Object.keys(map)) {
        const t = (map[k] && map[k].total) || 0;
        if (k !== homeKey && t > total) { total = t; key = k; }
      }
      if (!key) return null;
      if (total < 1e9 || total < 2 * homeMax) return null;
      return { key, total, homeMax };
    },

    logSummary(snap, tag = "cached") {
      if (!snap) { log("[FLEET RECON] no snapshot yet — open the Fleet page once.", "warn"); return; }
      const ships = (snap.ships || []).map(s => `${s.type}${s.label ? `/${s.label}` : ""}=${s.qty.toLocaleString()}`).join(", ") || "NONE";
      const groups = (snap.groups || []).map(g => `"${g.text}"(${g.value})`).join(", ") || "none";
      const slots = `fleets ${snap.fleetSlots ? `${snap.fleetSlots.used}/${snap.fleetSlots.total}` : "?"}, expeditions ${snap.expoSlots ? `${snap.expoSlots.used}/${snap.expoSlots.total}` : "?"}`;
      log(`[FLEET RECON ${tag}] planet ${snap.planet || "?"} | slots: ${slots} | groups: ${groups}`, "info");
      log(`[FLEET RECON ${tag}] ships: ${ships}`, "info");
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  ONLINE BONUS CLAIMER  (v2.13.0, 2026-07-31)
  // ═══════════════════════════════════════════════════════════════
  // Every few hours OGameX puts a green "Online bonus" entry at the top of
  // the left menu; clicking it grants antimatter + Academy points. Pure
  // freebie, so the bot takes it — but through the same gates as every other
  // module: leader tab only, never mid-dispatch (the click can navigate and
  // would strand a 3-step fleet flow), and quiet during breaks/night so the
  // account doesn't click at 4am while it's supposed to be asleep.
  //
  // We don't know the exact markup ogamex.net uses, so detection is
  // label-driven and defensive:
  //   • strict pass — a text node that IS the label ("Online bonus", after
  //     stripping digits/punctuation), climbing ≤4 levels to the real
  //     clickable (<a>/<button>/[onclick]/role=button/cursor:pointer)
  //   • loose pass — a short label CONTAINING the phrase, but only on a
  //     genuine control (so prose like "you claimed your online bonus"
  //     can't be clicked)
  //   • never our own panel, never a disabled/greyed item, never an item
  //     showing a countdown (that's "next bonus in mm:ss", not a button)
  // The first sighting dumps the element's outerHTML into the persisted log
  // so the markup can be tightened later from a real observation.

  const OnlineBonus = {
    KEY_CLAIMS: "ogamex_bonus_claims",       // JSON array of claim timestamps
    KEY_NEXT_TRY: "ogamex_bonus_next_try_at",
    KEY_PENDING: "ogamex_bonus_pending",     // click awaiting verification
    KEY_MARKUP: "ogamex_bonus_markup_logged",
    LABEL_RE: /^(online bonus|bonus online)$/i,
    LOOSE_RE: /online\s*bonus|bonus\s*online/i,
    busy: false,

    // ── claim bookkeeping ──
    claims() {
      try {
        const arr = JSON.parse(GM_getValue(this.KEY_CLAIMS, "[]"));
        return Array.isArray(arr) ? arr.filter(t => t > Date.now() - 7 * 24 * 60 * 60 * 1000) : [];
      } catch { return []; }
    },
    recordClaim() {
      const arr = this.claims();
      arr.push(Date.now());
      GM_setValue(this.KEY_CLAIMS, JSON.stringify(arr));
    },
    lastClaimAt() {
      const a = this.claims();
      return a.length ? a[a.length - 1] : 0;
    },
    claimsToday() {
      const d = new Date();
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      return this.claims().filter(t => t >= start).length;
    },

    // ── DOM helpers ──
    isVisible(el) {
      if (!el || !el.getClientRects || el.getClientRects().length === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none" && parseFloat(st.opacity || "1") > 0.05;
    },

    // The greyed-out state may sit on the control OR on its <li>/wrapper, so
    // check a couple of levels up too.
    isDisabled(el) {
      for (let cur = el, i = 0; cur && i < 3; cur = cur.parentElement, i++) {
        if (cur.disabled) return true;
        if (cur.getAttribute && cur.getAttribute("aria-disabled") === "true") return true;
        const cls = typeof cur.className === "string" ? cur.className : "";
        if (/disabl|inactive|locked|cooldown|unavailable|not-?active/i.test(cls)) return true;
      }
      return false;
    },

    // Nearest real control at or above `el` (menu entries are usually <a>/<li>).
    // A real control ALWAYS wins over the cursor heuristic: `cursor` is an
    // inherited CSS property, so the label <span> inside a clickable <a>
    // computes to `pointer` as well — trusting it first returned the span and
    // lost both the href fallback and the wrapper's disabled/greyed classes.
    clickableFor(el) {
      let pointer = null;
      for (let cur = el, i = 0; cur && cur !== document.body && i < 5; cur = cur.parentElement, i++) {
        if (/^(A|BUTTON|INPUT)$/.test(cur.tagName)) return cur;
        if (cur.hasAttribute && (cur.hasAttribute("onclick") || cur.getAttribute("role") === "button")) return cur;
        try {
          if (getComputedStyle(cur).cursor === "pointer") {
            const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
            if (t.length <= 40) pointer = cur; // outermost node that is still just the label
          }
        } catch {}
      }
      return pointer;
    },

    find() {
      // Cheap prefilter: one string scan per tick instead of a full DOM walk.
      if (!this.LOOSE_RE.test(document.body.textContent || "")) return null;

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node, loose = null;
      while ((node = walker.nextNode())) {
        const raw = (node.nodeValue || "").replace(/\s+/g, " ").trim();
        if (!raw || raw.length > 60 || !this.LOOSE_RE.test(raw)) continue;
        const parent = node.parentElement;
        if (!parent || (parent.closest && parent.closest("#ogx-bot-panel"))) continue; // our own UI/log
        const ctrl = this.clickableFor(parent);
        const target = ctrl || parent;
        if (!this.isVisible(target)) continue;

        const label = (target.textContent || "").replace(/\s+/g, " ").trim();
        const letters = raw.replace(/[^\p{L} ]/gu, "").replace(/\s+/g, " ").trim();
        const hit = { el: target, node: raw, label: label.slice(0, 80) };
        if (this.LABEL_RE.test(letters)) return hit;           // strict: the node IS the label
        if (ctrl && label.length <= 40 && !loose) loose = hit;  // loose: a real control, short label
      }
      return loose;
    },

    // Some UIs put the reward behind a confirm inside a modal. Only click a
    // confirm that sits in a container actually talking about the bonus.
    clickConfirmIfAny() {
      const btns = document.querySelectorAll("button, a, input[type='button'], input[type='submit']");
      for (const b of btns) {
        if (b.closest && b.closest("#ogx-bot-panel")) continue;
        const t = ((b.textContent || b.value || "") + "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 24) continue;
        if (!/^(claim|collect|receive|get( it)?|odbierz|zbierz|confirm|ok|yes)$/i.test(t)) continue;
        if (!this.isVisible(b) || this.isDisabled(b)) continue;
        // Smallest meaningful container around the button — NOT <body>, whose
        // text always contains "Online bonus" (the menu entry) and would make
        // this match any stray OK button on the page.
        let ctx = "";
        for (let cur = b.parentElement, i = 0; cur && cur !== document.body && i < 5; cur = cur.parentElement, i++) {
          const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
          if (t.length >= 20) { ctx = t.slice(0, 600); break; }
        }
        if (!/bonus|antimatter|dark\s*matter|academy/i.test(ctx)) continue;
        log(`Online bonus: confirming via "${t}".`, "info");
        this.humanClick(b);
        return true;
      }
      return false;
    },

    humanClick(el) {
      const opts = { bubbles: true, cancelable: true, view: window };
      try {
        el.dispatchEvent(new MouseEvent("mouseover", opts));
        el.dispatchEvent(new MouseEvent("mousedown", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
      } catch {}
      try { el.click(); } catch {}
    },

    markup(el) {
      return ((el && el.outerHTML) || "").replace(/\s+/g, " ").slice(0, 300);
    },

    // Resolve a click made earlier (possibly before a page navigation).
    // Returns true while the outcome is still undecided.
    // `force` = we just clicked in THIS tick and already waited out the UI,
    // so judge immediately instead of deferring to the next scheduler tick.
    settle(force = false) {
      let pend = null;
      try { pend = JSON.parse(GM_getValue(this.KEY_PENDING, "null")); } catch {}
      if (!pend) return false;
      const age = Date.now() - (pend.at || 0);
      if (!force && age < 2000) return true; // too early to judge

      const still = this.find();
      if (!still) {
        GM_setValue(this.KEY_PENDING, "null");
        this.recordClaim();
        const gap = Math.max(1, CONFIG.onlineBonus?.minGapMin || 2);
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + gap * 60 * 1000));
        log(`Online bonus CLAIMED — antimatter + Academy points (#${this.claimsToday()} today).`, "success");
        updateStatusUI();
        return false;
      }
      if (age > 20000 || force) {
        GM_setValue(this.KEY_PENDING, "null");
        const retry = Math.max(1, CONFIG.onlineBonus?.retryMin || 15);
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + retry * 60 * 1000));
        log(`Online bonus: clicked but the button is still there — retry in ${retry}min. Markup: ${this.markup(still.el)}`, "warn");
        updateStatusUI();
        return false;
      }
      return true; // still settling
    },

    async run({ manual = false } = {}) {
      if (this.busy) return;
      if (!manual && !CONFIG.onlineBonus?.enabled) return;

      if (this.settle()) return; // a previous click is still being judged

      if (!manual) {
        const nextTry = parseInt(GM_getValue(this.KEY_NEXT_TRY, "0")) || 0;
        if (Date.now() < nextTry) return;
      }

      // A click may navigate — never do it in the middle of a fleet flow.
      const pending = GM_getValue("pending_mission", null);
      if (pending && pending !== "null") return;
      if (AsteroidMiner.running || InactiveFarmer.running || ExpeditionRunner.running) return;

      const hit = this.find();
      if (!hit) {
        if (manual) log("No 'Online bonus' button visible on this page right now.", "warn");
        return;
      }

      // Learn the real markup once — the persisted log can be copied out.
      if (!GM_getValue(this.KEY_MARKUP, "")) {
        GM_setValue(this.KEY_MARKUP, "1");
        log(`Online bonus markup (first sighting): ${this.markup(hit.el)}`, "info");
      }

      if (this.isDisabled(hit.el)) {
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + 10 * 60 * 1000));
        log(`Online bonus entry present but disabled/greyed — skipping for 10min.`, "info");
        return;
      }
      // "Online bonus 04:12" = countdown to the NEXT bonus, not a claimable one.
      if (/\d{1,2}:\d{2}/.test(hit.label)) {
        GM_setValue(this.KEY_NEXT_TRY, String(Date.now() + 5 * 60 * 1000));
        log(`Online bonus shows a countdown ("${hit.label}") — not claimable yet.`, "info");
        return;
      }

      this.busy = true;
      try {
        log(`Online bonus detected ("${hit.label}") — claiming.`, "success");
        const href = hit.el.tagName === "A" ? hit.el.getAttribute("href") : null;

        // ── v2.17.1: claim FAST, and by navigation when we can ──
        // Live log 16:07:54: "Online bonus detected — claiming." and then…
        // nothing, with the button still on screen minutes later. The claim was
        // losing a race: it slept 1.2-4s for human-reaction realism while the
        // asteroid scanner navigated to the next galaxy page ~2s later, killing
        // the page mid-claim. Every scan step is another lost bonus.
        // The button is a plain link (<a href="/home/onlinebonus" id=
        // "btn-online-bonus">), so going straight to that URL is both the
        // fastest and the most reliable claim — it's one atomic navigation
        // instead of a click plus several seconds of page life.
        const realHref = href && href !== "#" && !/^javascript:/i.test(href) ? (hit.el.href || href) : null;
        if (realHref) {
          GM_setValue(this.KEY_PENDING, JSON.stringify({ at: Date.now(), label: hit.label }));
          await AntiDetection.sleep(150 + Math.random() * 450); // enough to not be instant, too short to lose the race
          log(`Online bonus: navigating to ${href}`, "fleet");
          window.location.replace(realHref);
          return;
        }
        // Stamp BEFORE clicking: if the click navigates, this page's JS dies
        // and only the marker (read on the next page's first tick) can tell
        // us the claim went through.
        GM_setValue(this.KEY_PENDING, JSON.stringify({ at: Date.now(), label: hit.label }));
        this.humanClick(hit.el);

        await AntiDetection.sleep(1500 + Math.random() * 1500);
        this.clickConfirmIfAny();
        await AntiDetection.sleep(1500 + Math.random() * 1000);

        // Still here (no navigation) → judge now instead of waiting a tick.
        if (this.find() && href && href !== "#" && !/^javascript:/i.test(href)) {
          log(`Online bonus: click didn't take — following its link (${href}).`, "warn");
          window.location.replace(hit.el.href || href);
          return;
        }
        this.settle(true);
      } catch (err) {
        log(`Online bonus error: ${err.message}`, "error");
      } finally {
        this.busy = false;
      }
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  FLEET RETURN TIME PARSER
  // ═══════════════════════════════════════════════════════════════

  // After sending a fleet, the page shows fleet movement info.
  // Parse the return time so the bot knows when to scan again.
  // Looks for patterns like:
  //   "Next: 14:04" (HH:MM today)
  //   Countdown timers (data-arrival, data-return attributes)
  //   Fleet event rows with timestamps
  function parseFleetReturnTime() {
    const now = new Date();
    const bodyText = document.body.textContent;

    // Pattern 1: "Next: MM:SS" or "Next: HH:MM:SS" — countdown to next fleet event
    // IMPORTANT: Only use if "Type:" is asteroid-related. "Next:" shows ANY fleet type!
    const nextMatch = bodyText.match(/Next:\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
    if (nextMatch) {
      // Check if the mission type near "Next:" is asteroid mining
      const typeMatch = bodyText.match(/Type:\s*(\w[\w\s]*)/);
      const missionType = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
      const isAsteroidMission = missionType.includes("asteroid") || missionType.includes("mining");

      const hours = nextMatch[1] ? parseInt(nextMatch[1]) : 0;
      const minutes = parseInt(nextMatch[2]);
      const seconds = parseInt(nextMatch[3]);
      const countdownMs = (hours * 3600 + minutes * 60 + seconds) * 1000;

      if (isAsteroidMission) {
        // (R) = return phase — countdown IS the return time, don't ×2
        const isReturn = /Asteroid\s*Mining\s*\(R\)/i.test(bodyText);
        if (isReturn) {
          log(`Parsed asteroid fleet RETURN countdown: ${hours}h${minutes}m${seconds}s`, "fleet");
          return now.getTime() + countdownMs;
        }
        log(`Parsed asteroid fleet countdown: ${hours}h${minutes}m${seconds}s (×2 for round trip)`, "fleet");
        return now.getTime() + countdownMs * 2;
      } else {
        log(`Next fleet is "${missionType}", not asteroid mining — ignoring countdown`, "fleet");
        // Don't use this countdown — fall through to other patterns
      }
    }

    // Pattern 2: data-return-time or data-arrival on fleet movement elements
    const returnEl = document.querySelector("[data-return-time], [data-arrival]");
    if (returnEl) {
      const ts = parseInt(returnEl.dataset.returnTime || returnEl.dataset.arrival || "0");
      if (ts > 0) {
        const returnMs = ts > 1e12 ? ts : ts * 1000;
        log(`Parsed fleet return from DOM attr: ${new Date(returnMs).toLocaleTimeString("en-GB")}`, "fleet");
        return returnMs;
      }
    }

    // Pattern 3: Flight time display (e.g. "Flight time: 00:12:34")
    const flightMatch = bodyText.match(/[Ff]light\s*time:\s*(\d{1,2}):(\d{2}):(\d{2})/);
    if (flightMatch) {
      const flightMs = (parseInt(flightMatch[1]) * 3600 + parseInt(flightMatch[2]) * 60 + parseInt(flightMatch[3])) * 1000;
      return now.getTime() + flightMs * 2;
    }

    return null;
  }

  // v2.10.1: how many miners were left at home after the most recent dispatch.
  // Returns -1 when unknown/stale (no record, or older than a full round trip),
  // which callers treat as "assume none home" — the safe default that keeps the
  // bot from scanning when it has nothing to send. This is what makes parallel
  // mode dormant until right-sizing actually leaves miners behind: a 100% send
  // (minersNeeded=0, the pre-learning fallback) leaves 0 home → bot waits, just
  // like the old serial behaviour.
  // ── v2.24.0: count the hangar, don't remember it ──
  // This used to answer ONLY from the last dispatch record: available − toSend,
  // valid for maxFlightMinutes×2+10 = 100 minutes. After a send that took every
  // miner it therefore reported "0 home" for an hour and a half, long after the
  // fleets had landed. Owner's log, 2026-08-01: "Parallel: no miners home (0) →
  // wait for fleet return" at 10:59:09, and four seconds later the fleet page
  // listed ASTEROID_MINER qty 7 200 000 000. Seven point two BILLION miners sat
  // idle because of a stale arithmetic memory. The live page always wins; the
  // recon cache (written on every fleet-page visit) is the second choice; the
  // dispatch estimate is the last resort it always should have been.
  function minersHomeLive() {
    const types = [...(CONFIG.asteroidMining.minerShipTypes || []), "ASTEROID_MINER"];
    for (const t of types) {
      const el = document.querySelector(`[data-ship-type="${t}"]`);
      if (el) {
        const n = parseInt(el.dataset.shipQuantity || "0");
        if (Number.isFinite(n)) return n;
      }
    }
    return -1;
  }

  function minersHomeFromRecon(maxAgeMs = 10 * 60 * 1000) {
    try {
      const snap = JSON.parse(GM_getValue("ogamex_fleet_recon", "null"));
      if (!snap?.at || Date.now() - snap.at > maxAgeMs) return -1;
      const types = [...(CONFIG.asteroidMining.minerShipTypes || []), "ASTEROID_MINER"];
      for (const t of types) {
        const s = (snap.ships || []).find(x => x.type === t);
        if (s && Number.isFinite(s.qty)) return s.qty;
      }
    } catch {}
    return -1;
  }

  function minersHomeAfterLastDispatch() {
    const live = minersHomeLive();
    if (live >= 0) return live;
    const recon = minersHomeFromRecon();
    if (recon >= 0) return recon;
    let d = null;
    try { d = JSON.parse(GM_getValue("ogamex_last_dispatch", "null")); } catch {}
    if (!d || !Number.isFinite(d.available) || !Number.isFinite(d.toSend)) return -1;
    // v2.24.0: the estimate is only believable for as long as a dispatch takes
    // to matter — one round trip, not two plus ten minutes. Past that the
    // fleets are back and the arithmetic is fiction.
    const maxAgeMs = (CONFIG.asteroidMining.maxFlightMinutes + 5) * 60 * 1000;
    if (!d.at || Date.now() - d.at > maxAgeMs) return -1; // stale — tells us nothing about now
    return d.available - d.toSend;
  }

  // v2.10.4: max simultaneous mining flights. If the user set a miner budget
  // ("total miners to use") and a per-flight size, the cap = floor(total/per)
  // — e.g. 100000 / 50000 = 2 flights. Otherwise fall back to the explicit
  // maxConcurrentMiningFleets (0 = no cap → limited only by game fleet slots).
  function maxMiningFleets() {
    const am = CONFIG.asteroidMining;
    const total = am.totalMinersToUse || 0;
    const per = am.minersPerMission || 0;
    if (total > 0 && per > 0) return Math.max(1, Math.floor(total / per));
    return am.maxConcurrentMiningFleets || 0;
  }

  // v2.10.8: count in-flight fleets from the page's REAL fleet-status bar
  // ("N Missions: M Own"), NOT an estimate. History:
  //   - ≤v2.10.6: a counter that only reset to 0 when ALL fleets were home →
  //     stuck at max with staggered fleets (waited forever).
  //   - v2.10.7: estimated each fleet's return ETA and pruned on expiry — but
  //     ETAs ran short (asteroid mining dwell + flight-time error), so a fleet
  //     got pruned WHILE STILL IN FLIGHT → undercount → the bot freed the
  //     budget early, scanned with fleets still out, and tried to dispatch a
  //     4th fleet with too few miners (Send button disabled → dispatch failed).
  // Ground truth is the live page. During the wait the bot sits on a
  // fleet-status page (the "Type: Asteroid Mining" header is what triggers the
  // wait), so "M Own" is reliably present and drops the instant a fleet lands.
  // On a page WITHOUT the bar (e.g. galaxy scan) we keep the last stored count
  // — conservative: never free the budget on a blind page.
  function inflightFleetCount() {
    const m = document.body.textContent.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
    const stored = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
    if (!m) return stored; // no fleet bar on this page → last known (conservative)
    const own = parseInt(m[2]) || 0;
    // Post-send race guard: the page may not yet list a fleet we dispatched in
    // the last 30s, so don't let a stale-low read drop below what we just sent.
    const sinceSend = Date.now() - (parseInt(GM_getValue("ogamex_last_dispatch_at", "0")) || 0);
    const reconciled = (sinceSend < 30000 && own < stored) ? stored : own;
    if (reconciled !== stored) GM_setValue("ogamex_inflight_fleets", String(reconciled));
    return reconciled;
  }

  function clearInflightFleets() {
    GM_setValue("ogamex_inflight_fleets", "0");
  }

  // v2.15.1: MINING fleets only. inflightFleetCount() reads "M Own", i.e. every
  // mission we own — including expeditions. Mining's parallel budget
  // (floor(totalMinersToUse / minersPerFlight)) was therefore being eaten by
  // expedition waves: 3 expeditions + 1 mining flight read as "4/4 — flight
  // budget reached", and the asteroid scanner stopped dispatching. The game
  // reports its own expedition counter ("Expeditions: X/Y"), so subtract it.
  // Fleet-SLOT maths (farmer reserve, expedition reserve) still uses the full
  // count — there every fleet really does occupy a slot.
  // ── v2.30.0: don't mix fresh with stale ──
  // Mining = all missions minus expeditions. But those two numbers are read
  // from DIFFERENT places: "N Missions: M Own" is in the top bar (also on
  // the galaxy page), while "Expeditions: X/Y" only on the fleet page. Away from it the counter
  // fell back to the CACHE and we subtracted last year's number from
  // today's. The owner keeps 10 expeditions airborne non-stop, so
  // the error could be huge: the log showed "flight budget reached (5/3)", i.e.
  // five mining flights against a limit of three — after which mining blocked
  // its own dispatches. On the owner's biggest source of income.

  // Returns -1 = I DON'T KNOW. Callers treat that as "budget doesn't block":
  // a mistake in this direction costs at most one flight over the limit, which
  // resolves itself, while the other direction costs mining downtime.
  // ── v2.39.1: count OUR OWN mining flights, not "what's left after subtracting" ──
  // The "all missions minus expeditions" formula assumed everything that isn't
  // an expedition is mining. The owner also plays manually — colonizes,
  // ferries resources — and those missions counted against the mining budget. Log at 11:54:
  // "flight budget reached (28/3) → scan paused ~90min". Twenty-eight
  // mining flights against a limit of three, with a real three in the air.
  // Mining sat idle for an hour and a half on the owner's main source of income.

  // The bot sends these fleets itself and records them itself: DispatchedAsteroids keeps an entry until
  // the moment of arrival (releaseAt, stamped with the game's flight time). This is
  // the exact number of our mining missions in flight — no guessing, no
  // dependence on whatever else the human is doing on the account.
  function miningInflightCount() {
    // First purge the ghosts (entries the game no longer sees), then count.
    const m = document.body.textContent.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
    if (m) {
      const own = parseInt(m[2]);
      // a freshly sent fleet may not yet be on the game's list (~30 s) —
      // so don't prune then, or we'd delete a real flight
      const sinceSend = Date.now() - (parseInt(GM_getValue("ogamex_last_dispatch_at", "0")) || 0);
      if (sinceSend > 30000) {
        const dropped = MiningFlights.reconcile(own);
        if (dropped > 0)
          log(`Flight registry: pruned ${dropped} ghost entr(ies) (game sees ${own} missions) — budget unlocked.`, "asteroid");
      }
    }
    return MiningFlights.count();
  }

  // v2.10.1: set the scan-pause timer from the page header countdown (factored
  // out so both the legacy serial path and the parallel "must wait" path share
  // identical logic).
  function setFleetReturnTimerFromHeader(headerText, storedReturnAt) {
    const nextMatch = headerText.match(/Next:\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
    if (nextMatch) {
      const hours = nextMatch[1] ? parseInt(nextMatch[1]) : 0;
      const minutes = parseInt(nextMatch[2]);
      const seconds = parseInt(nextMatch[3]);
      const countdownMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
      const isReturn = /Asteroid\s*Mining\s*\(R\)/i.test(headerText);
      // (R) = return phase, countdown IS return time. Otherwise ×2 for round trip.
      const returnAt = Date.now() + (isReturn ? countdownMs : countdownMs * 2) + 60000;
      GM_setValue("ogamex_fleet_return_at", String(returnAt));
      const newWait = Math.ceil((returnAt - Date.now()) / 60000);
      log(`Asteroid fleet active! Timer set: ~${newWait}min (countdown ${hours}h${minutes}m${seconds}s${isReturn ? ' R' : ' ×2'})`, "asteroid");
    } else if (storedReturnAt && storedReturnAt > Date.now()) {
      const minLeft = Math.ceil((storedReturnAt - Date.now()) / 60000);
      log(`Asteroid fleet active, can't parse countdown. Using stored timer (~${minLeft}min).`, "asteroid");
    } else {
      const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
      GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
      log(`Asteroid fleet active but no countdown found. Estimated ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min wait.`, "asteroid");
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PARALLEL DISPATCH DECISION  (v2.10.0)
  // ═══════════════════════════════════════════════════════════════
  // After a mining fleet is sent, decide whether to keep scanning (send the
  // leftover miners to OTHER asteroids in parallel) or pause until a fleet
  // returns. Returns true = keep scanning.
  //
  // The pause is implemented by setting ogamex_fleet_return_at, which every
  // existing scan gate already honours — so parallel mode simply means "don't
  // set that timer while we still have miners + a free fleet slot." When we DO
  // pause we use the soonest return so a freed slot (and the miners aboard)
  // gets reused as early as possible, not after the whole fleet is home.
  function decideAfterMiningSend({ available, toSend, capturedFlightMs }) {
    const am = CONFIG.asteroidMining;
    const minersLeftHome = (Number.isFinite(available) && Number.isFinite(toSend)) ? available - toSend : 0;
    const slots = GameState.getFleetSlots();
    const slotsFree = slots.total > 0 ? slots.total - slots.used : 1;
    // v2.10.8: we just sent a fleet — bump the stored floor by 1 and stamp the
    // time, so inflightFleetCount()'s page-reconciliation race guard knows a
    // fresh fleet may not appear in "M Own" for a few seconds. The real count
    // then takes over from the live page as soon as it shows the new fleet.
    const storedNow = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
    GM_setValue("ogamex_inflight_fleets", String(storedNow + 1));
    GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
    const inflight = miningInflightCount(); // "M Own" minus expeditions (v2.15.1)
    const maxConc = maxMiningFleets(); // floor(totalMinersToUse / perFlight), or maxConcurrentMiningFleets
    // inflight < 0 = count unknown → budget doesn't block (v2.30.0)
    const concOk = maxConc <= 0 || inflight < 0 || inflight < maxConc;

    // ── v2.22.0: don't launch the scraps ──
    // The flight budget is floor(totalMinersToUse / perFlight), which counts
    // miners the hangar may not actually hold. Owner's case: 5.0B miners,
    // 2.4B per flight, budget 3 flights → the third launched with the 200M
    // remainder. That flight isn't free money: the game caps a mission's haul
    // at the fleet's TOTAL cargo, so 200M miners came back with exactly
    // 200M × 20 750 = 4.15T — the cap to the digit, i.e. the asteroid had more
    // and the rest was left in the ground. Those miners earn far more as part
    // of the next full flight, so a parallel leg now has to be worth flying.
    const intendedPerFlight = am.minersPerMission > 0 ? am.minersPerMission : AsteroidYieldTracker.minersNeeded();
    const ratio = Number.isFinite(am.partialFlightMinRatio) ? am.partialFlightMinRatio : 0.5;
    const worthFlying = !(intendedPerFlight > 0 && ratio > 0) ||
      minersLeftHome >= Math.ceil(intendedPerFlight * ratio);

    const canParallel = am.parallelDispatch &&
      minersLeftHome >= (am.minMinersPerMission || 1) &&
      worthFlying &&
      slotsFree > 0 && concOk;

    if (canParallel) {
      GM_setValue("ogamex_fleet_return_at", "0"); // don't gate scanning
      log(`PARALLEL: sent ${toSend}, ~${minersLeftHome} miners still home, ${slotsFree} slot(s) free → keep scanning for more asteroids.`, "asteroid");
      return true;
    }

    // Pause until the soonest fleet return.
    let returnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
    if (!returnAt || returnAt < Date.now()) {
      if (capturedFlightMs > 0) returnAt = Date.now() + capturedFlightMs * 2 + 60000;
      else {
        const parsed = parseFleetReturnTime();
        returnAt = (parsed && parsed > Date.now()) ? parsed
          : Date.now() + CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
      }
      GM_setValue("ogamex_fleet_return_at", String(returnAt));
    }
    const reason = !am.parallelDispatch ? "parallel off"
      : !worthFlying ? `scraps: ${minersLeftHome} miners at home is less than ${Math.round(ratio * 100)}% of a flight (${intendedPerFlight}) — waiting for a return instead of wasting an asteroid on half a fleet`
      : minersLeftHome < (am.minMinersPerMission || 1) ? "no miners left home"
      : slotsFree <= 0 ? "fleet slots full"
      : `flight budget reached (${inflight < 0 ? "?" : inflight}/${maxConc} flights)`;
    log(`WAIT (${reason}): scan paused ~${Math.ceil((returnAt - Date.now()) / 60000)}min until a fleet returns.`, "asteroid");
    return false;
  }

  // ═══════════════════════════════════════════════════════════════
  //  MISSION FLOW HANDLER: Continue multi-page fleet dispatch
  // ═══════════════════════════════════════════════════════════════

  let _handlingMission = false;
  // ── v2.74.2: VERIFYING ship fields after entry (rescue/FS) ──
  // The fleet form recalculates after every input/change and can ZERO OUT
  // a field entered moments earlier. Incident 05.08 23:22: the log said
  // "loaded: … BATTLE_CRUISER×1381054574 …", and 1.38 bn BC stayed
  // home. So after entering we read every field BACK, top up the shortfalls
  // (2 rounds), and only then accept it as loaded.
  async function verifyShipInputs(tag, excludeUpper = []) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    for (let round = 1; round <= 2; round++) {
      await AntiDetection.sleep(600 + Math.random() * 300);
      const bad = [];
      for (const el of document.querySelectorAll("[data-ship-type]")) {
        const type = el.dataset.shipType;
        const want = parseInt(el.dataset.shipQuantity || "0") || 0;
        if (!type || want <= 0 || excludeUpper.includes(type.toUpperCase())) continue;
        const item = el.closest(".ship-item") || el.parentElement;
        const input = item?.querySelector("input.numberFormatInput, input[type='text']");
        if (!input) continue;
        const have = parseInt((input.value || "0").replace(/[^\d]/g, "")) || 0;
        if (have < want) {
          bad.push(`${type} (${have.toLocaleString()}/${want.toLocaleString()})`);
          if (nativeSetter) nativeSetter.call(input, want); else input.value = want;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      if (!bad.length) {
        if (round > 1) log(`[${tag}] ship field verification: complete after topping up.`, "fleet");
        return true;
      }
      log(`[${tag}] ship field verification (round ${round}): the form lost ${bad.join(", ")} — re-entering.`, "warn");
    }
    log(`[${tag}] WARNING: after 2 rounds of topping up the form still lost fields — flying with what's in the form (details above).`, "error");
    return false;
  }

  // ── v2.80.2: the FERRY must present itself as FERRY ──
  // The ferry (MoonFerry) goes through EXACTLY the same machinery as the rescue, so
  // its steps were logged as [MOON SAVE] and [RESCUE]. On 07.08 at 13:28
  // the owner saw "[RESCUE] switching the active body" and
  // "[MOON SAVE] target: MOON" during a routine ferry run and decided the bot
  // was fleeing an attack. Fair enough — that's how it looked.
  //
  // The journal distinguished this from the start (entries "reading/FERRY", so as not to
  // falsify the defense counters), but the live log didn't. Words reserved
  // for an emergency must describe an emergency, otherwise
  // they stop meaning anything — exactly the same principle for which
  // routine waiting stopped being red in v2.77.2.
  function missionTag(fallback) {
    try {
      const p = GM_getValue("pending_mission", null);
      if (p && p !== "null" && /moon_ferry/.test(p)) return "FERRY";
    } catch {}
    return fallback;
  }

  // ── v2.74.0: deuterium reserve on rescue/FS ──
  // Called AFTER clicking btn-all-res on step 3: it takes the reserve amount
  // off the deuterium field so the body isn't left with zero fuel (a fleet
  // returning from an expedition must have fuel to flee). We find the deuterium row by
  // btn-res-full pairs — on this fork there are 3 in metal/crystal/deuterium order
  // (live dump step3-clickables 05.08 23:03). No match: we touch nothing.
  async function applyDeutReserve(tag) {
    const reserve = Math.max(0, parseInt(CONFIG.threatAlarm?.deutReserve) || 0);
    if (!reserve) return;
    try {
      const fulls = [...document.querySelectorAll("a.btn-res-full, .btn-res-full")];
      if (fulls.length < 3) { log(`[${tag}] deuterium reserve: can't see 3 resource rows (${fulls.length}) — leaving as is.`, "warn"); return; }
      const row = fulls[2].closest("div, tr, li") || fulls[2].parentElement;
      const input = row?.querySelector("input") ||
                    fulls[2].parentElement?.querySelector("input");
      if (!input) { log(`[${tag}] deuterium reserve: no field next to the deuterium row — leaving as is.`, "warn"); return; }
      const current = parseInt((input.value || "0").replace(/[^\d]/g, "")) || 0;
      if (current <= reserve) { log(`[${tag}] deuterium reserve: the tank holds ${current.toLocaleString()} ≤ reserve — not taking any deuterium at all.`, "fleet"); }
      const keep = Math.max(0, current - reserve);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, keep); else input.value = keep;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      log(`[${tag}] deuterium reserve: leaving ${Math.min(current, reserve).toLocaleString()} on the body, taking ${keep.toLocaleString()}.`, "fleet");
      await AntiDetection.sleep(300 + Math.random() * 300);
    } catch (e) { log(`[${tag}] deuterium reserve: error (${e.message}) — resources unchanged.`, "warn"); }
  }

  async function handlePendingMission() {
    if (_handlingMission) return;
    // v2.10.25: a non-leader tab must NEVER execute a pending mission — this
    // was the exact mechanism of the triple-send (several tabs on the fleet
    // page each resumed the same pending_mission within seconds).
    if (!requireLeader("pending-mission")) return;
    const raw = GM_getValue("pending_mission", null);
    if (!raw) return;
    _handlingMission = true;

    let mission;
    try {
      mission = JSON.parse(raw);
    } catch {
      GM_setValue("pending_mission", null);
      _handlingMission = false; // v2.10.10: early return before the try/finally — don't leak the flag
      return;
    }

    // Expire old missions (>5 minutes)
    if (Date.now() - mission.timestamp > 5 * 60 * 1000) {
      log("Pending mission expired, clearing", "warn");
      GM_setValue("pending_mission", null);
      _handlingMission = false; // v2.10.10: same — a leaked flag made this fn a no-op until next reload
      return;
    }

    // ── v2.73.1: a rescue/ferry mission aimed at a body we NO LONGER HAVE ──
    // Incident 22:25 05.08: the owner moved the base [3:269:8]→[3:272:7]
    // DURING an alert. The hanging rescue aimed at the old coordinates and LOOPED
    // (switching bodies refreshes the timestamp, so the 5-minute expiry didn't
    // catch it). A rescue always aims at OUR body — if the mission's coordinates
    // aren't on the planet list, that mission is a mine from the previous base.
    if (mission.moonSave && mission.atCoords) {
      // v2.75.4: do NOT trust GameState.getPlanets() — on this fork it parses ONE
      // planet (the active one) out of 30, so every mission to a non-active colony
      // came out as "non-existent" and DISARMED the guard (incident 22:18
      // 06.08: base [3:272:7] deemed non-existent, guard removed, fleet
      // left on the planet without auto-return). The only reliable source for the list
      // of our bodies is ownBodies() (planet-shortcut select + GM cache).
      // An empty list = "I don't know" — we don't touch the mission then.
      const own = ThreatMonitor.ownBodies();
      const c = mission.atCoords;
      const ours = own.has(`${c.galaxy}:${c.system}:${c.position}`);
      if (own.size > 1 && !ours) {
        log(`[RESCUE] dropping the hanging mission ${mission.type} → [${c.galaxy}:${c.system}:${c.position}] — we have no body there (base move).`, "warn");
        ThreatLog.add("reading", `Dropped mission ${mission.type} aimed at a non-existent body [${c.galaxy}:${c.system}:${c.position}] (base moved) — this is cleanup, not a failure.`);
        // v2.73.2: a return to a body we don't have would be retried by
        // the guard in a loop (incident 22:54: ERROR + voice every few minutes). The guard
        // was guarding the OLD base — disarm it together with the mission.
        MoonSave.disarm("rescue/return target does not exist (base move)");
        GM_setValue("pending_mission", null);
        _handlingMission = false;
        return;
      }
    }

    // ── v2.68.4: bot OFF interrupts ROUTINE missions in progress ──
    // Incident 05.08 10:32-10:33: the owner turned the bot off at 10:32:17, and wave
    // #15 still went out at 10:33:38 — an in-progress mission resumed on
    // every page reload because this function didn't check the main
    // switch. OFF must mean STOP. Exception: rescue (moonSave) — the
    // RESCUE/RETURN buttons also work with the bot off, and abandoning an evacuation
    // halfway through the form would be worse than finishing it.
    if (!CONFIG.enabled && !mission.moonSave) {
      log(`Bot OFF — dropping the in-progress mission (${mission.type}). Turn the bot on if it should finish.`, "warn");
      GM_setValue("pending_mission", null);
      _handlingMission = false;
      return;
    }

    const page = GameState.getCurrentPage();
    log(`Continuing mission: ${mission.type}, step: ${mission.step}, page: ${page}`, "fleet");

    try {
      // ── Planet switch step: we landed on a planet page, now go to fleet ──
      if (mission.step === "switch_planet_then_fleet" && mission.switchToFleetUrl) {
        log(`Planet switched. Navigating to fleet: ${mission.switchToFleetUrl}`, "fleet");
        mission.step = "select_ships_direct";
        mission.timestamp = Date.now();
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(1000 + Math.random() * 1500);
        window.location.replace(mission.switchToFleetUrl);
        return;
      }

      // ── v2.21.0: the return leg starts on the MOON ──
      // A fleet launches from whichever body is active in the sidebar, and
      // after a save the active body is still the (now empty) planet. So the
      // moon has to be selected first, or the "return" would fly nothing from
      // the planet to itself. The sidebar renders each moon right after its
      // planet, so the base planet's entry identifies its moon — no coord
      // parsing, no guessing which of the moons is ours.
      if (mission.step === "switch_to_body" || mission.step === "switch_to_moon") {
        // v2.28.0: generalised from "switch to the moon". Either body can be
        // the refuge now, so the step switches to mission.launchBody — the one
        // the fleet fled to and must take off from. Old missions that still say
        // switch_to_moon mean the moon.
        const want = mission.launchBody || "moon";
        const here = MoonSave.currentBody();
        const sidebar = document.querySelectorAll("a.planet-select, .planet-select, a.moon-select, .moon-select");
        if (!sidebar.length) {
          // No sidebar on this page — go where there is one instead of giving up.
          log("[RESCUE] no planet list on this page — going to Overview and back to the return.", "fleet");
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(500 + Math.random() * 500);
          window.location.replace("/");
          return;
        }
        if (here === want) {
          log(`[RESCUE] we're already on the right body (${want === "moon" ? "moon" : "planet"}) — going straight to the form.`, "fleet");
          mission.step = "select_ships_direct";
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
          await AntiDetection.sleep(500 + Math.random() * 500);
          window.location.replace(mission.fleetUrl);
          return;
        }
        // Find the base entry in the sidebar. The game renders each moon right
        // after its planet, so the pair identifies itself by adjacency — no
        // coordinate parsing, and it works whichever half is currently active.
        const b = mission.atCoords || HomeBase.coords();
        let target = null;
        // ── v2.87.2: FIRST match by COORDS from the anchor text ──
        // LIVE incident 14:35: return to [5:67:5] with Colony 11 active
        // — the old heuristic (href/selected pair) took the ACTIVE pair
        // and the return loaded a FOREIGN colony's hangar (4 colony ships,
        // 215 million HC, 849 bn resources) into a 37-minute flight. pairAnchor
        // matches the pair by the coords in the text — the same mechanism
        // the launchAt gate has switched pairs flawlessly since v2.84.
        const anchorByCoords = b ? HomeBase.pairAnchor(b) : null;
        if (anchorByCoords) target = want === "moon" ? (HomeBase.moonOf(anchorByCoords) || anchorByCoords) : anchorByCoords;
        const planets = [...document.querySelectorAll("a.planet-select, .planet-select")];
        if (!target) for (const p of planets) {
          const href = p.getAttribute("href") || "";
          const isBase = b && href.includes(`${b.galaxy}`) && href.includes(`${b.system}`) && href.includes(`${b.position}`);
          // v2.82.0: STOP at the next planet entry — without this a pair
          // WITHOUT a moon "borrowed" the next planet's moon from the list and
          // the whole dispatch went out from someone else's body.
          let moon = p.nextElementSibling;
          while (moon && !(moon.classList && moon.classList.contains("moon-select"))) {
            if (moon.classList && moon.classList.contains("planet-select")) { moon = null; break; }
            moon = moon.nextElementSibling;
          }
          const mineHere = isBase || p.classList.contains("selected") ||
                           (moon && moon.classList.contains("selected"));
          if (!mineHere) continue;
          target = want === "moon" ? moon : p;
          if (isBase) break;
        }
        if (!target) {
          // Never disarm on failure: the fleet is still parked on the refuge and
          // the guard is the only way back through the bot.
          log(`[RESCUE] RETURN FAILED: couldn't find the base's ${want === "moon" ? "moon" : "planet"} in the list. The fleet stays in place, the guard is working — click RETURN again or move it manually.`, "error");
          ThreatLog.add("ERROR", `Return interrupted: the base's ${want === "moon" ? "moon" : "planet"} is missing from the planet list. The fleet stayed at the refuge.`);
          GM_setValue("pending_mission", null);
          return;
        }
        log(`[${missionTag("RESCUE")}] switching the active body to the base's ${want === "moon" ? "moon" : "planet"}…`, "fleet");
        mission.step = "switch_planet_then_fleet";
        mission.switchToFleetUrl = mission.fleetUrl;
        mission.timestamp = Date.now();
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(600 + Math.random() * 600);
        const href = target.getAttribute("href");
        if (href && href.length > 1) window.location.replace(href); else target.click();
        return;
      }

      // ── Direct asteroid mining: fleet URL has coords + mission pre-set ──
      // 3-step form on same page: Select ships → Confirm destination → Send fleet
      if (mission.step === "select_ships_direct" && page === "fleet") {
        // ── v2.69.0: MOON MODE — routine dispatches launch from the moon ──
        // One choke point instead of four mission-creation sites: every mission
        // (mining/expedition/debris) passes through here before the form.
        // Wrong launch side → switch to the base moon with the same machinery
        // FS and the rescue return have proven live.
        // Rescue (moonSave) and FS have their own body logic — untouched.
        // v2.74.8: farm LAUNCHES FROM THE CURRENT body (owner decision 06.08
        // before the idle-farming event) — the owner moves the fleet between
        // planets/moons to shorten arrivals; a forced launch from the base
        // would undo those moves.
        // ── v2.84.0: START FROM ENTERED COORDS (launchAt) ──
        // The mission carries the launch point chosen when it was created:
        // hard coords from the panel (miners ↔ expeditions may have DIFFERENT
        // ones) or the active body. If a DIFFERENT pair is active — the bot
        // clicks the right entry on the planet bar (the planet or its moon per
        // baseBody) and returns to the form with the same mechanics as miner
        // rotation. Rescue and FS have their own launch logic — untouched.
        // Farm (v2.91.0) carries launchAt ONLY with entered coords, so it
        // chooses itself whether to pass through here; without coords launchAt doesn't exist and nothing changes.
        if (mission.launchAt && !mission.moonSave && !mission.fleetSave && !mission.originChecked) {
          const want = mission.launchAt;
          const here = HomeBase.read();
          const samePair = here && here.galaxy === want.galaxy && here.system === want.system && here.position === want.position;
          if (here && !samePair) {
            mission.originChecked = true; // one pair correction per mission — no loop
            const anchor = HomeBase.pairAnchor(want);
            if (anchor) {
              const wantMoon = (want.body || (CONFIG.baseBody === "moon" ? "moon" : "planet")) === "moon";
              const targetEl = wantMoon ? (HomeBase.moonOf(anchor) || anchor) : anchor;
              if (wantMoon && targetEl === anchor) {
                log(`[START] the pair [${want.galaxy}:${want.system}:${want.position}] has no moon — launching from the PLANET (the phalanx sees this flight).`, "warn");
              }
              mission.step = "switch_planet_then_fleet";
              mission.switchToFleetUrl = mission.fleetUrl;
              mission.timestamp = Date.now();
              GM_setValue("pending_mission", JSON.stringify(mission));
              log(`[START] mission ${mission.type} launches from [${want.galaxy}:${want.system}:${want.position}]${targetEl !== anchor ? " (moon)" : ""} — switching the active body.`, "fleet");
              await AntiDetection.sleep(600 + Math.random() * 600);
              const href = targetEl.getAttribute("href");
              if (href && href.length > 1) window.location.replace(href); else targetEl.click();
              return;
            }
            // The coords aren't on the planet bar (typo in the panel / not our
            // colony) — log it loudly and continue from the active body so the
            // dispatch rotation never freezes.
            log(`[START] couldn't find [${want.galaxy}:${want.system}:${want.position}] in the planet list — CHECK the start coordinates in the panel. Launching from the active body.`, "error");
            GM_setValue("pending_mission", JSON.stringify(mission));
          }
        }
        // v2.82.0: "base moon" → "moon of the CURRENT system". The operator
        // picks the launch spot by switching planets; moon mode only tightens
        // the BODY within that pair. A system without a moon =
        // launch from the planet (conscious cost: the phalanx sees this flight).
        if (CONFIG.baseBody === "moon" && !mission.moonSave && !mission.fleetSave && (!mission.farm || mission.launchAt) && !mission.launchChecked) {
          const here = MoonSave.currentBody();
          if (here && here !== "moon") {
            mission.launchChecked = true; // one correction per mission — no loop
            if (HomeBase.pairMoon()) {
              mission.step = "switch_to_body";
              mission.launchBody = "moon";
              mission.atCoords = mission.atCoords || HomeBase.coords();
              mission.timestamp = Date.now();
              GM_setValue("pending_mission", JSON.stringify(mission));
              log(`[BASE=MOON] mission ${mission.type} was about to launch from the planet — switching to the moon of the current system before the dispatch.`, "warn");
              setTimeout(() => { handlePendingMission().catch(() => {}); }, 1200);
              return;
            }
            GM_setValue("pending_mission", JSON.stringify(mission)); // launchChecked survives a reload
            log(`[BASE=MOON] the current system has no moon — mission ${mission.type} launches from the PLANET (the phalanx sees this flight).`, "warn");
          }
        }
        // ── v2.87.2: THE FORM NEVER DISPATCHES FROM A FOREIGN COLONY ──
        // Rescue/return carries atCoords = the colony in question. If the
        // form opened on a DIFFERENT pair (a missed switch —
        // the 14:35 incident), it would load that hangar and send it into flight.
        // One correction attempt via pairAnchor; a second failure = a loud
        // abort. A fleet from a foreign colony must not fly "on the side".
        if (mission.moonSave && mission.atCoords) {
          const herePair = HomeBase.read();
          const wantPair = mission.atCoords;
          const samePairNow = herePair && herePair.galaxy === wantPair.galaxy && herePair.system === wantPair.system && herePair.position === wantPair.position;
          if (herePair && !samePairNow) {
            if (!mission.pairChecked) {
              mission.pairChecked = true;
              const a2 = HomeBase.pairAnchor(wantPair);
              if (a2) {
                const el2 = (mission.launchBody === "moon") ? (HomeBase.moonOf(a2) || a2) : a2;
                mission.step = "switch_planet_then_fleet";
                mission.switchToFleetUrl = mission.fleetUrl;
                mission.timestamp = Date.now();
                GM_setValue("pending_mission", JSON.stringify(mission));
                log(`[RESCUE] the form opened on a FOREIGN colony [${herePair.galaxy}:${herePair.system}:${herePair.position}] instead of [${wantPair.galaxy}:${wantPair.system}:${wantPair.position}] — switching and coming back to the form.`, "warn");
                await AntiDetection.sleep(500 + Math.random() * 500);
                const h2 = el2.getAttribute("href");
                if (h2 && h2.length > 1) window.location.replace(h2); else el2.click();
                return;
              }
            }
            log(`[RESCUE] ABORTED: the form is on a foreign colony [${herePair.galaxy}:${herePair.system}:${herePair.position}], the target is [${wantPair.galaxy}:${wantPair.system}:${wantPair.position}] — I will NOT move a fleet from a foreign colony.`, "error");
            DefenceWatchdog.note(`rescue/return aborted: the form is on a foreign colony, target [${wantPair.galaxy}:${wantPair.system}:${wantPair.position}]`);
            GM_setValue("pending_mission", null);
            return;
          }
        }
        // ── v2.10.23/24: same-target send guard (defence in depth) ──
        // Nothing downstream re-checks DispatchedAsteroids, so ANY path that
        // replays a pending_mission (send succeeded but the browser never
        // reached fleetSendSuccessfully, so pending_mission was never cleared
        // and the next page load resumes it) dispatches a second fleet to the
        // exact same coords. Window is short vs DispatchedAsteroids' 1h so a
        // legitimately respawned asteroid at the same coords is still mineable
        // later.
        // v2.10.24: compare COORDS, not url strings — the same asteroid gets a
        // different fleetUrl per detection method (raw game href vs
        // reconstructed /fleet?x=..&y=..), so url-equality let dupes through
        // whenever two dispatch cycles detected it differently (observed
        // 2026-07-20: 2-3 fleets to one asteroid, minutes apart).
        // v2.14.0: EXPEDITIONS ARE EXEMPT. Both guards below exist to stop two
        // fleets landing on one asteroid; an expedition wave is the opposite —
        // 8 fleets to the SAME [g:s:16] minutes apart IS the feature. Leaving
        // the guard on would have let wave 1 through and silently blocked
        // waves 2..N as "duplicates".
        const SEND_GUARD_MS = 10 * 60 * 1000;
        const missionCoord = coordsFromFleetUrl(mission.fleetUrl);
        if (!mission.expedition && !mission.moonSave && !mission.fleetSave) try {
          const lastSent = readLastSent(); // v2.10.25: GM + localStorage, newest wins
          const sameTarget = lastSent && (
            (missionCoord && lastSent.coord && lastSent.coord === missionCoord) ||
            lastSent.url === mission.fleetUrl // fallback when coords unparseable
          );
          // v2.10.25: block until the fleet's ARRIVAL when known (stamped at
          // send time from the game's own flight-time display) — after arrival
          // the asteroid is consumed and a same-coords respawn is fair game.
          // Fallback: flat 10min window.
          const blockedUntil = lastSent ? (lastSent.releaseAt || lastSent.at + SEND_GUARD_MS) : 0;
          if (sameTarget && Date.now() < blockedUntil) {
            const agoSec = Math.round((Date.now() - lastSent.at) / 1000);
            log(`DUPLICATE BLOCKED: already sent a fleet to [${missionCoord || mission.fleetUrl}] ${agoSec}s ago. Not sending again.`, "warn");
            GM_setValue("pending_mission", null);
            return; // inside the try — the finally resets _handlingMission
          }
        } catch {}

        // v2.10.25: server-truth check — catches a fleet launched seconds ago
        // by another tab, another browser or another machine, which no local
        // storage guard can see. Expeditions skip it for the same reason as above.
        const alreadyFlying = (mission.expedition || mission.moonSave || mission.fleetSave) ? null : await fleetAlreadyFlyingTo(missionCoord);
        if (alreadyFlying) {
          log(`DUPLICATE BLOCKED (server events via ${alreadyFlying}): a fleet is already en route to [${missionCoord}]. Aborting send.`, "warn");
          GM_setValue("pending_mission", null);
          return;
        }

        // v2.90.0: label by mission type (previously everything went out as
        // "direct asteroid", including farm attacks and debris runs).
        log(`Fleet page loaded (${mission.farm ? "farm attack" : mission.recycle ? "recycle" : mission.expedition ? "expedition" : "direct asteroid"}). Starting 3-step dispatch...`, "fleet");

        // ── v2.83.0: OFF must mean STOP even IN THE MIDDLE of the form ──
        // v2.68.4 aborts a mission on RESUME (page reload), but
        // clicking OFF mid-way through the 3 steps was never checked anywhere — 12.08
        // 08:48:42 the owner turned the bot off and the expedition wave still
        // went out a second later. A gate before every click that pushes the
        // form forward. Same exception as in 2.68.4: a rescue (moonSave)
        // always finishes — abandoning an evacuation halfway is worse than completing it.
        const offAbort = (where) => {
          if (CONFIG.enabled || mission.moonSave) return false;
          log(`Bot OFF — aborting mission ${mission.type} before the "${where}" step. Nothing was sent.`, "warn");
          GM_setValue("pending_mission", null);
          return true;
        };

        // Flight time captured in step 2, used by finishDispatch
        let capturedFlightMs = 0;
        // v2.10.0: miner counts captured at step 1, read by finishDispatch to
        // decide parallel-vs-wait. Also persisted to ogamex_last_dispatch so the
        // fleetSendSuccessfully init handler (the usual post-send entry point)
        // can make the same decision.
        let dispatchInfo = { available: 0, toSend: 0 };

        // ── Helper: after dispatch, decide whether to resume scan or wait ──
        // dispatchOk=true: fleet sent → resume scanning if miners remain home
        //   and a fleet slot is free (parallel), else wait for a fleet to return.
        // dispatchOk=false: dispatch failed → resume scan (try next asteroid)
        const finishDispatch = async (dispatchOk) => {
          GM_setValue("pending_mission", null);
          // ── v2.11.0: farm missions manage their own state — the mining
          // wait/return timers below must stay untouched (they'd pause the
          // asteroid scanner over an HC attack). Success AND failure both just
          // hand control back to the farmer (next target / resume sweep);
          // a failed target stays on its FarmedTargets cooldown.
          // v2.14.0: expeditions own their pacing/counters and must not touch
          // the mining wait timers (a 1h expedition would pause the scanner).
          if (mission.moonSave) {
            if (mission.airSave && dispatchOk) { try { AirSave.afterSend(mission); } catch {} } // v2.85.0
            if (dispatchOk) log(`[${missionTag("MOON SAVE")}] fleet and resources are on the moon.`, "success");
            return;
          }
          if (mission.fleetSave) {
            if (dispatchOk) FleetSave.markLaunched(mission);
            else log("[FS] the dispatch didn't go through — the planner will retry while the window still fits.", "warn");
            return;
          }
          if (mission.expedition) {
            if (dispatchOk) {
              const storedExp = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
              GM_setValue("ogamex_inflight_fleets", String(storedExp + 1));
              GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
              ExpeditionRunner.afterSend();
            }
            return;
          }
          // v2.59.0: recycling has had its own flag since 2.48.0, but
          // finishDispatch didn't know about it — after a debris run it went
          // to the MINING bookkeeping and (on failure) set the scanner pause
          // from the recyclers' flight time. Debris says nothing about where the miners are.
          if (mission.recycle) {
            if (dispatchOk) log("[DEBRIS] recyclers sent for the debris field.", "success");
            else log("[DEBRIS] the recycler dispatch didn't go through — I'll try on the next visit.", "warn");
            return;
          }
          if (mission.farm) {
            if (dispatchOk) {
              // Same in-flight bump as the fleetSendSuccessfully farm branch
              // (this path runs when the click did NOT navigate away).
              const storedNow2 = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
              GM_setValue("ogamex_inflight_fleets", String(storedNow2 + 1));
              GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
              Humanizer.recordAttack(); // v2.12.0: daily cap counter
            }
            await InactiveFarmer.afterSend();
            return;
          }
          if (dispatchOk) {
            // Decide parallel vs wait based on miners left home + free slots.
            const goParallel = decideAfterMiningSend({
              available: dispatchInfo.available,
              toSend: dispatchInfo.toSend,
              capturedFlightMs,
            });
            if (goParallel) {
              const remainingScan = ScanState.load();
              if (remainingScan?.active && remainingScan.queue?.length > 0) {
                const next = remainingScan.queue[0];
                await AntiDetection.shortDelay();
                scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "parallel resume");
              } else {
                endSweepWithCooldown("Queue exhausted after dispatch"); // v2.12.4
              }
              return;
            }
            ScanState.clear();
            return;
          }
          // Dispatch failed — check WHY before resuming
          // If we have captured flight time, use it (miners were probably just sent)
          if (capturedFlightMs > 0) {
            const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
            GM_setValue("ogamex_fleet_return_at", String(returnTime));
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure — miners in flight
            const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
            log(`Using captured flight time. Miners return in ~${minLeft}min.`, "asteroid");
            ScanState.clear();
            return;
          }
          // No captured time — check if already have a stored return time
          const storedReturn = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
          if (storedReturn && Date.now() < storedReturn) {
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure
            const minLeft = Math.ceil((storedReturn - Date.now()) / 60000);
            log(`Miners in flight. Waiting ~${minLeft}min for return.`, "asteroid");
            ScanState.clear();
            return;
          }
          // No stored time — try parsing from page header (now filters by asteroid type)
          const parsedReturn = parseFleetReturnTime();
          if (parsedReturn && parsedReturn > Date.now()) {
            GM_setValue("ogamex_fleet_return_at", String(parsedReturn));
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure
            const minLeft = Math.ceil((parsedReturn - Date.now()) / 60000);
            log(`Parsed asteroid fleet return from page: ~${minLeft}min.`, "asteroid");
            ScanState.clear();
            return;
          }
          // Last resort — conservative fallback
          const fleetText = document.body.textContent;
          const fleetActive = fleetText.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
          if (fleetActive && parseInt(fleetActive[2]) > 0) {
            const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
            GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
            GM_setValue("ogamex_dispatch_fail_at", "0"); // not a real failure — fleet active
            log(`Miners likely in flight (${fleetActive[2]} own missions). Estimated ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min wait.`, "asteroid");
            ScanState.clear();
            return;
          }
          // No fleet in flight — resume scanning for next asteroid
          if (!mission.resumeScan) return;
          const remainingScan = ScanState.load();
          if (remainingScan?.active && remainingScan.queue?.length > 0) {
            const next = remainingScan.queue[0];
            log(`Dispatch failed, resuming scan: ${remainingScan.queue.length} systems left. Next: [${next.galaxy}:${next.system}]`, "asteroid");
            await AntiDetection.shortDelay();
            scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "post-dispatch resume");
          } else {
            endSweepWithCooldown("Queue exhausted after failed dispatch"); // v2.12.4
          }
        };

        // ── Helper: dump visible buttons for debugging ──
        const dumpButtons = (label) => {
          const btns = Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']"))
            .filter(el => el.offsetParent !== null)
            .map(el => {
              const txt = (el.value || el.textContent || "").trim().substring(0, 40);
              return txt ? `"${txt}"[${el.tagName}${el.className ? '.' + el.className.split(' ')[0] : ''}]` : null;
            })
            .filter(Boolean)
            .slice(0, 15);
          log(`[${label}] Buttons: ${btns.join(", ")} | URL: ${window.location.pathname}`, "fleet");
        };

        // ── v2.66.2: do NOT click a disabled button ──
        // Twice in the logs (02.08 12:47 and 03.08 23:21) the bot clicked "Next"
        // with the `disabled` class — the game was still computing the ship
        // selection (a wave is a dozen or so types entered one after another).
        // A click on a dead button does nothing, the next step never appears,
        // 12 s timeout and the wave is lost. We wait until the button comes alive, with a hard time limit.
        const isDisabled = (el) => !el ? true
          : (el.disabled || el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true");
        const findButton = (text) => {
          const fleetArea = document.querySelector("#content, .content, main, #fleet, .fleet-content, .fleet-form") || document.body;
          let btn = Array.from(fleetArea.querySelectorAll("a, button, input[type='submit']")).find(
            el => el.textContent.trim() === text && el.offsetParent !== null
          );
          if (!btn) btn = fleetArea.querySelector(`input[value="${text}"]`);
          if (!btn) {
            btn = Array.from(document.querySelectorAll("a, button, input[type='submit']")).find(
              el => el.textContent.trim() === text && el.offsetParent !== null &&
                    !el.closest(".sidebar, nav, .planet-list, #ogx-bot-panel") &&
                    !el.classList.contains("text-item") && !el.classList.contains("resource-item")
            );
          }
          return btn || null;
        };
        // v2.66.3: 9 s wasn't enough — the last wave of the series (the WHOLE
        // hangar, 23:26 in the log: 33.7 bn fighters in a single form) keeps
        // Next dead longer, because the game validates giant numbers on the
        // server side. 25 s + at the end we tell the TRUTH: "it was there but
        // dead the whole time" is different from "it wasn't there at all",
        // and we dump the form area's text — if the game printed a reason
        // (e.g. no deuterium), it'll be in the log.
        const clickButtonWhenEnabled = async (text, label, maxWaitMs = 25000) => {
          const start = Date.now();
          let waited = false, lastSeen = null;
          while (Date.now() - start < maxWaitMs) {
            const btn = findButton(text);
            lastSeen = btn;
            if (btn && !isDisabled(btn)) {
              if (waited) log(`Button "${text}" came alive after ${((Date.now() - start) / 1000).toFixed(1)}s — clicking.`, "fleet");
              btn.click();
              log(`Clicked "${text}" (${btn.tagName}.${btn.className} id=${btn.id}) [${label}]`, "fleet");
              return true;
            }
            if (btn && !waited) {
              waited = true;
              log(`Button "${text}" is disabled (the game is still computing) — waiting instead of clicking a dead element.`, "fleet");
            }
            await AntiDetection.sleep(400);
          }
          const formTxt = (document.querySelector("#content, .content, form") || document.body)
            .textContent.replace(/\s+/g, " ").trim();
          log(lastSeen
            ? `Button "${text}" stayed DISABLED for ${Math.round(maxWaitMs / 1000)}s [${label}] — the game won't accept this fleet. Form text: …${formTxt.slice(-400)}`
            : `Button "${text}" doesn't exist on the page at all [${label}].`, "error");
          return false;
        };

        // ── Helper: find button and click with multiple methods ──
        const clickButton = (text, label) => {
          const fleetArea = document.querySelector("#content, .content, main, #fleet, .fleet-content, .fleet-form") || document.body;
          let btn = Array.from(fleetArea.querySelectorAll("a, button, input[type='submit']")).find(
            el => el.textContent.trim() === text && el.offsetParent !== null
          );
          if (!btn) {
            btn = fleetArea.querySelector(`input[value="${text}"]`);
          }
          if (!btn) {
            btn = Array.from(document.querySelectorAll("a, button, input[type='submit']")).find(
              el => el.textContent.trim() === text && el.offsetParent !== null &&
                    !el.closest(".sidebar, nav, .planet-list, #ogx-bot-panel") &&
                    !el.classList.contains("text-item") && !el.classList.contains("resource-item")
            );
          }
          if (!btn) return false;
          // v2.10.23: click ONCE. HTMLElement.click() already dispatches a
          // bubbling click event and runs the default action, so the extra
          // dispatchEvent(new MouseEvent("click")) that used to follow it fired
          // every handler a SECOND time. On "Next" that could skip a wizard
          // step; on "Send fleet" it launched a duplicate fleet (see step 3).
          btn.click();
          log(`Clicked "${text}" (${btn.tagName}.${btn.className} id=${btn.id}) [${label}]`, "fleet");
          return true;
        };

        // ── Helper: wait for DOM change (step transition) ──
        const waitForStepChange = async (indicator, maxWaitMs = 8000) => {
          const start = Date.now();
          while (Date.now() - start < maxWaitMs) {
            await AntiDetection.sleep(500);
            if (indicator()) return true;
          }
          return false;
        };

        // ═══ STEP 1: Select Asteroid Miners ═══
        await AntiDetection.sleep(1500 + Math.random() * 2000);

        const allShips = document.querySelectorAll("[data-ship-type]");
        const shipDump = Array.from(allShips).map(s =>
          `${s.dataset.shipType}(qty:${s.dataset.shipQuantity},tag:${s.tagName})`
        ).join(", ");
        log(`Ships on page: ${shipDump || "NONE"}`, "fleet");
        dumpButtons("step1-before");

        // ── v2.17.0: fleet save takes EVERYTHING ──
        // No splitting, no exclusions, no reserve: every hull on the planet
        // goes, miners included. The whole point is that nothing is left where
        // the attack lands.
        if (mission.moonSave) {
          // ── v2.34.0: returning to where the fleet already is is not a return ──
          // Owner: "it should move the fleet when an attack is flying at it" —
          // and he was right that what the bot was doing had nothing to do with
          // that. After the false alarm at 09:24 the fleet came back to the moon,
          // but the guard stayed armed, so the return kept firing in a loop:
          // switch to the planet, open the form, set the MOON as the target —
          // while already standing on the moon. Target equals source, so the game greys out "Next" and we hit the timeout. And so on forever.
          const bodyNow = MoonSave.currentBody();
          if (mission.moonReturn && bodyNow && bodyNow === mission.targetBody) {
            log(`[RESCUE] the fleet is already on the ${bodyNow === "moon" ? "moon" : "planet"} — nothing to pull back. Ending the return.`, "success");
            ThreatLog.add("RETURN", `Fleet already on the ${bodyNow === "moon" ? "moon" : "planet"} (return target) — return unnecessary, guard removed.`);
            GM_setValue("pending_mission", null);
            MoonSave.disarm("fleet already on the target body");
            return;
          }
          // ── v2.75.1: rescue from the BODY the attack is flying at — on every colony ──
          // After switching to the attacked colony, the PLANET becomes active
          // (the anchor in the list), and the attack usually targets the moon
          // with the fleet. Instead of loading what sits on the safe body (and
          // sending it INTO the attack), we jump straight to the attacked body
          // and rescue from there — the same machinery as the flip with an empty hangar.
          // v2.85.0: target body per colony (mission.atCoords), with a global
          // fallback. An air escape does NOT flip "to the attacked body" —
          // BOTH are attacked; we launch from wherever the fleet stands.
          const missionKey = mission.atCoords ? `${mission.atCoords.galaxy}:${mission.atCoords.system}:${mission.atCoords.position}` : null;
          const atkNow = (() => { try { const ev = ThreatMonitor.events(); return (missionKey && ev?.targetBodies?.[missionKey]) || ev?.targetBody || null; } catch { return null; } })();
          if (!mission.moonReturn && !mission.flippedBody && !mission.sweep && !mission.airSave
              && (MoonSave.watch().saves || 0) <= 1 && ThreatMonitor.active()
              && atkNow && bodyNow && bodyNow !== atkNow) {
            log(`[MOON SAVE] the attack targets the ${atkNow === "moon" ? "MOON" : "PLANET"}, and I'm standing on the ${bodyNow === "moon" ? "moon" : "planet"} — switching to the attacked body and rescuing from there.`, "warn");
            ThreatLog.add("RESCUE", `Attack target: ${atkNow === "moon" ? "moon" : "planet"} → rescuing from it to the ${bodyNow === "moon" ? "moon" : "planet"}.`);
            mission.flippedBody = true;
            mission.launchBody = atkNow;
            mission.targetBody = bodyNow;
            mission.step = "switch_to_body";
            mission.timestamp = Date.now();
            GM_setValue("pending_mission", JSON.stringify(mission));
            const w = MoonSave.watch();
            MoonSave.saveWatch({ ...w, homeBody: atkNow, refugeBody: bodyNow });
            await AntiDetection.sleep(500 + Math.random() * 500);
            window.location.replace("/");
            return;
          }
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const loaded = [];
          for (const el of document.querySelectorAll("[data-ship-type]")) {
            const type = el.dataset.shipType;
            const available = parseInt(el.dataset.shipQuantity || "0") || 0;
            if (!type || available <= 0) continue;
            const item = el.closest(".ship-item") || el.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text']");
            if (!input) continue;
            if (nativeSetter) nativeSetter.call(input, available); else input.value = available;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            loaded.push(`${type}×${available}`);
            // Emergency: no human-pacing delay here. Every second counts and a
            // fleet save is exactly the moment a real player also hammers it.
          }
          if (!loaded.length) {
            // ── v2.66.0: an empty hangar with an ACTIVE alert = the fleet sits
            // on the OTHER body of the same coordinates. Until now the rescue
            // ended here with the word "aborting" — and a big fleet stayed on
            // the attacked moon while the bot with a clear conscience rescued
            // an empty planet. We switch to the other body and rescue FROM
            // THERE (the direction reverses by itself: from=the body active
            // after the switch).
            // One attempt — if it's empty there too, the fleet is in the air
            // and there is nothing to rescue.
            // ── v2.70.3: flip ONLY on the FIRST rescue of an alert ──
            // During a SWEEP an empty hangar means "nothing new landed",
            // not "look for the fleet on the other side". Incident 16:20:
            // after a successful moon→planet evacuation the guard found an
            // empty moon and the flip moved the fleet from the safe planet
            // BACK to the attacked moon (arrival 16 s before the impact — only
            // the enemy's retreat saved us) and also changed homeBody, so the
            // return parked the fleet on the wrong body. Additionally: the flip can never make the body an attack is flying at the target.
            const hereB = MoonSave.currentBody() || "planet";
            const emptyKey = mission.atCoords ? `${mission.atCoords.galaxy}:${mission.atCoords.system}:${mission.atCoords.position}` : null;
            const atkB = (() => { try { const ev = ThreatMonitor.events(); return (emptyKey && ev?.targetBodies?.[emptyKey]) || ev?.targetBody || null; } catch { return null; } })();
            // v2.85.0: an air escape MUST find the fleet — an empty hangar
            // on the active body = the fleet sits on the OTHER body of THAT pair; flip
            // without the "attack into the other body" condition, because both are attacked.
            if (!mission.moonReturn && !mission.flippedBody && !mission.sweep
                && (mission.airSave || ((MoonSave.watch().saves || 0) <= 1 && ThreatMonitor.active() && atkB !== hereB))) {
              const here = hereB;
              const other = here === "moon" ? "planet" : "moon";
              log(`[MOON SAVE] hangar on the ${here === "moon" ? "moon" : "planet"} is EMPTY and the alert is still on — the fleet sits on the ${other === "moon" ? "moon" : "planet"}. Switching and rescuing from there.`, "warn");
              ThreatLog.add("RESCUE", `Hangar ${here} empty with an alert → fleet on ${other}. Switching body and rescuing ${other} → ${here}.`);
              mission.flippedBody = true;
              mission.launchBody = other;
              // v2.85.0: with an air escape the TARGET is another colony —
              // the mission's targetBody stays untouched (the refuge planet).
              if (!mission.airSave) mission.targetBody = here;
              mission.step = "switch_to_body";
              mission.timestamp = Date.now();
              GM_setValue("pending_mission", JSON.stringify(mission));
              // The guard must know where home is so the return goes the right
              // way. An air escape does not arm the guard — we don't touch it.
              if (!mission.airSave) {
                const w = MoonSave.watch();
                MoonSave.saveWatch({ ...w, homeBody: other, refugeBody: here });
              }
              await AntiDetection.sleep(500 + Math.random() * 500);
              window.location.replace("/");
              return;
            }
            log(`[${missionTag("MOON SAVE")}] nothing on this planet to save — aborting.`, "warn");
            DefenceWatchdog.note(`hangar empty on ${MoonSave.currentBody() || "?"} — nothing to rescue`);
            GM_setValue("pending_mission", null);
            // v2.34.0: on a RETURN, empty at the refuge means there is nothing
            // to pull back — the fleet already returned or is on its way.
            // Retrying every five minutes was exactly the loop the owner saw.
            if (mission.moonReturn) {
              // ── v2.74.5: empty can also mean "the rescue is STILL FLYING" ──
              // 6.08 12:32: the return reached the refuge 24 s after the rescue
              // was sent (81 s flight), found nothing and disarmed the guard —
              // the rescue landed a minute later with no protection. If fewer
              // than 130 s have passed since the rescue was sent/created, the guard STAYS and the return retries after the flight.
              const w = MoonSave.watch();
              const ref = Math.max(w.lastSendAt || 0, w.lastAt || 0);
              if (w.armed && ref && Date.now() < ref + Math.max(130000, (w.lastFlightMs || 0) + 60000)) {
                log("[RETURN] the refuge is empty but the rescue is still flying — the guard stays, I'll retry after landing.", "warn");
                ThreatLog.add("RETURN", "Refuge empty, but the rescue is in flight — waiting for landing (guard armed).");
                MoonSave.saveWatch({ ...w, returning: false });
                return;
              }
              ThreatLog.add("RETURN", "The refuge is empty — nothing to pull back. Guard removed.");
              MoonSave.disarm("refuge empty — return moot");
            }
            return;
          }
          log(`[${missionTag("MOON SAVE")}] loading everything: ${loaded.join(", ")}`, "success");
          await verifyShipInputs("MOON SAVE"); // v2.74.2: the form drops fields
          // v2.71.0: the ferry is logistics — a "reading" entry doesn't disturb the defense counters.
          ThreatLog.add(mission.ferry ? "reading" : "RESCUE", `${mission.ferry ? "FERRY loaded" : "Loaded"}: ${loaded.join(", ")}`);
        } else

        // ── v2.60.0: Fleet Save — everything EXCEPT the exclusions (miners stay) ──
        // The same machinery as a rescue (native setter + input/change), only
        // with a filter: excludeTypes from the FS config (default ASTEROID_MINER —
        // miners work at night and have nothing to look for on an FS).
        if (mission.fleetSave) {
          // v2.74.4: miners stay home ONLY while mining is running (that's what
          // they're there for). Mining off = 7.5 bn miners is an ordinary target
          // on the moon (owner 05.08: "the miners stayed on the moon") — they fly with the FS.
          const excludeCfg = (CONFIG.fleetSave?.excludeTypes || ["ASTEROID_MINER"]).map(t => String(t).toUpperCase());
          const exclude = CONFIG.asteroidMining?.enabled ? excludeCfg : excludeCfg.filter(t => t !== "ASTEROID_MINER");
          if (excludeCfg.length !== exclude.length) log("[FS] mining disabled — miners do NOT stay, they fly with the fleet.", "fleet");
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const loaded = [];
          for (const el of document.querySelectorAll("[data-ship-type]")) {
            const type = el.dataset.shipType;
            const available = parseInt(el.dataset.shipQuantity || "0") || 0;
            if (!type || available <= 0) continue;
            if (exclude.includes(type.toUpperCase())) continue;
            const item = el.closest(".ship-item") || el.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text']");
            if (!input) continue;
            if (nativeSetter) nativeSetter.call(input, available); else input.value = available;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            loaded.push(`${type}×${available}`);
            await AntiDetection.sleep(120 + Math.random() * 380);
          }
          if (!loaded.length) {
            // v2.66.0: without this stamp the tick retried the launch every 30 s
            // for the whole window — a navigation mill at a moon with no fleet.
            GM_setValue("ogamex_fs_fail_at", String(Date.now()));
            log(`[FS] no fleet to send on the launch moon (outside the exclusions) — doing nothing. Ships: ${shipDump}`, "warn");
            GM_setValue("pending_mission", null);
            return;
          }
          log(`[FS] loaded: ${loaded.join(", ")}${mission.fsMeasure ? " (measurement — no dispatch)" : ""}`, "fleet");
          await verifyShipInputs("FS", exclude); // v2.74.2: the form drops fields (BC 23:22)
        } else

        // ── v2.14.0: expeditions fill MANY types in one go ──
        // Mining/farming send a single ship type; an expedition takes the whole
        // combat fleet split into `waves`. Same input-writing mechanics as
        // below (native setter + input/change — React-style bindings ignore a
        // plain .value assignment), just applied per type.
        if (mission.expedition) {
          const { plan, skipped, empty } = expeditionShipPlan(mission.waves);
          if (!plan.length) {
            const why = shipDump === "NONE"
              ? "the hangar is empty (everything is already in the air)"
              : `excluded: ${skipped.join(", ") || "none"}; none left of: ${empty.join(", ") || "none"}`;
            log(`Expedition: no ships to send on the active planet — ${why}. Ships: ${shipDump}`, "warn");
            GM_setValue("pending_mission", null);
            // Back off a full wave-gap so we don't retry every tick.
            ExpeditionState.save({ ...ExpeditionState.load(), lastSendAt: Date.now(), nextGapMs: 10 * 60 * 1000 });
            return;
          }
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
          const filled = [];
          for (const p of plan) {
            const el = document.querySelector(`[data-ship-type="${p.type}"]`);
            const item = el?.closest(".ship-item") || el?.parentElement;
            const input = item?.querySelector("input.numberFormatInput, input[type='text']");
            if (!input) { log(`Expedition: no input for ${p.type} — skipping it.`, "warn"); continue; }
            if (nativeSetter) nativeSetter.call(input, p.qty); else input.value = p.qty;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            filled.push(`${p.type}×${p.qty}`);
            // v2.16.0: a human fills eleven boxes one after another, not all of
            // them inside the same millisecond. Cheap, and it's the kind of
            // timing signature that's actually visible to a server.
            await AntiDetection.sleep(120 + Math.random() * 380);
          }
          if (!filled.length) {
            log("Expedition: could not fill any ship input — aborting wave.", "error");
            stampDispatchFailIfMining(mission); // v2.95.0: a farm/debris/rescue failure doesn't park the scanner
            GM_setValue("pending_mission", null);
            return;
          }
          log(`Expedition wave composition (1/${mission.waves} of the fleet): ${filled.join(", ")}`, "fleet");
        } else {

        // Find the ship to send. Farm missions name their ship explicitly
        // (HEAVY_CARGO); asteroid missions try configured types first, then
        // fall back to ASTEROID/MINER naming.
        // v2.59.0: recycle also names its ship (RECYCLER). Without this
        // condition a debris run fell into the mining branch and loaded MINERS —
        // so the first real debris would have sent a mining fleet instead of recyclers.
        const shipTypesToTry = (mission.farm || mission.recycle)
          ? [mission.shipType]
          : [
              ...(CONFIG.asteroidMining.minerShipTypes || []),
              "ASTEROID_MINER", "ASTEROID", "MINER"
            ];
        let minerBtn = null;
        for (const shipType of shipTypesToTry) {
          minerBtn = document.querySelector(`[data-ship-type="${shipType}"]`) ||
                     document.querySelector(`[data-ship-type*="${shipType}"]`);
          if (minerBtn) {
            log(`Using ship type: ${shipType}`, "fleet");
            break;
          }
        }
        if (minerBtn) {
          const shipItem = minerBtn.closest(".ship-item") || minerBtn.parentElement;
          const input = shipItem?.querySelector("input.numberFormatInput, input[type='text']");
          const available = parseInt(minerBtn.dataset?.shipQuantity || input?.getAttribute("max-ships") || "0");
          // Right-sized send: mission.quantity comes from AsteroidYieldTracker
          // .minersNeeded() (0 = all available, the legacy fallback).
          const toSend = mission.quantity > 0 ? Math.min(mission.quantity, available) : available;
          // Record for the post-send parallel decision (both finishDispatch and
          // the fleetSendSuccessfully init handler read ogamex_last_dispatch).
          dispatchInfo = { available, toSend };
          // ogamex_last_dispatch feeds the MINING parallel decision
          // (minersHomeAfterLastDispatch) — HC counts must not pollute it.
          // v2.12.3 plausibility guard, recalibrated in v2.12.4: the 10M cap
          // false-flagged this server's REAL fleet (5 201 651 389 miners is a
          // genuine count on athena's inflated economy — confirmed against the
          // fleet page's own ship list). The guard now only catches true parse
          // garbage (e.g. concatenated digit runs), which lands far above any
          // real count. Above the cap store nothing: minersHomeAfterLastDispatch
          // returns "unknown", the designed fail-open path (keep scanning,
          // verify with the live ship count at dispatch time).
          // v2.59.0: recycle joins the farm — recording the RECYCLER count as
          // "miners at home" would break the mining parallel decision.
          if (!mission.farm && !mission.recycle) {
            const AVAIL_SANITY_CAP = 1_000_000_000_000; // 1e12
            if (available <= AVAIL_SANITY_CAP) {
              GM_setValue("ogamex_last_dispatch", JSON.stringify({ available, toSend, at: Date.now() }));
            } else {
              GM_setValue("ogamex_last_dispatch", "null");
              log(`Ship count sanity: available=${available} exceeds ${AVAIL_SANITY_CAP.toLocaleString()} — not recording (miners-home = unknown, verify at dispatch).`, "warn");
            }
          }

          if (input && toSend > 0) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(input, toSend);
            else input.value = toSend;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            // v2.90.0: label by mission type — "Asteroid Miners" on an attack
            // of a Heavy Cargo farm misled the owner in the logs.
            const shipLabel = (mission.farm || mission.recycle) ? (mission.shipType || "ships").replace("_", " ") : "Asteroid Miners";
            log(`Selected ${toSend}/${available} ${shipLabel} (input: ${input.className})`, "fleet");
          } else {
            log(`No ${mission.farm || mission.recycle ? mission.shipType : "Asteroid Miners"} available (found: ${available}, input: ${!!input})`, "error");
            stampDispatchFailIfMining(mission); // v2.95.0: farm/debris/rescue failure does not park the scanner
            // v2.11.1: farm with 0 HC on the active planet would otherwise
            // burn through the whole target queue (each retry stamps a target
            // cooldown and navigates for nothing). Pause the sweep instead.
            if (mission.farm) {
              FarmState.clear();
              GM_setValue("ogamex_farm_cooldown_until", String(Date.now() + 10 * 60 * 1000));
              log(`Farm: no ${mission.shipType} on the active body — sweep paused 10min.`, "warn");
              GM_setValue("pending_mission", null);
              return;
            }
            await finishDispatch(false);
            return;
          }
        } else {
          // ── v2.69.0: in moon mode we do NOT hunt for miners across colonies ──
          // They live on the base's moon; an empty hangar = they're in the air.
          // The old rotation would switch the active body to a colony and the whole
          // "everything from the moon" tactic would fall apart after one empty dispatch.
          if (CONFIG.baseBody === "moon") {
            log("No miners on the active moon — they're in the air. Waiting for the return (moon mode: no colony rotation).", "asteroid");
            GM_setValue("pending_mission", null);
            const storedReturnMoon = parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0;
            if (!(storedReturnMoon > Date.now())) GM_setValue("ogamex_fleet_return_at", String(Date.now() + 10 * 60 * 1000));
            return;
          }
          // No Asteroid Miners on this planet — try switching to another planet.
          // Track tried planets by coord key from the active sidebar entry. If we
          // can't detect the current planet from DOM (rare), fall back to using
          // the previously-stored "last switched to" key from a prior rotation
          // step so we still avoid an infinite loop.
          const triedPlanets = JSON.parse(GM_getValue("ogamex_tried_planets", "[]"));
          const currentPlanet = GameState.getCurrentPlanet();
          const lastSwitched = GM_getValue("ogamex_last_switched_planet", null);
          const currentKey = currentPlanet
            ? `${currentPlanet.galaxy}:${currentPlanet.system}:${currentPlanet.position}`
            : (lastSwitched || `unknown-${Date.now()}`);
          if (!triedPlanets.includes(currentKey)) {
            triedPlanets.push(currentKey);
            GM_setValue("ogamex_tried_planets", JSON.stringify(triedPlanets));
          }

          const planets = GameState.getPlanets();
          const nextPlanet = planets.find(p => {
            const key = `${p.galaxy}:${p.system}:${p.position}`;
            return !triedPlanets.includes(key) && p.link;
          });

          if (nextPlanet) {
            const nextKey = `${nextPlanet.galaxy}:${nextPlanet.system}:${nextPlanet.position}`;
            GM_setValue("ogamex_last_switched_planet", nextKey);
            log(`No Asteroid Miners on ${currentKey}. Trying ${nextPlanet.name} [${nextKey}]...`, "asteroid");
            // Keep the pending_mission, switch planet then go to fleet page
            mission.timestamp = Date.now(); // refresh expiry
            // First step: navigate to planet page to select it
            // Second step: navigate to fleet with asteroid coords (on next page load)
            mission.step = "switch_planet_then_fleet";
            mission.switchToFleetUrl = mission.fleetUrl;
            GM_setValue("pending_mission", JSON.stringify(mission));
            await AntiDetection.sleep(800 + Math.random() * 400);
            // Navigate to planet page to change active planet
            window.location.replace(nextPlanet.link);
            return;
          } else {
            GM_setValue("ogamex_tried_planets", "[]"); // reset for next time
            GM_setValue("ogamex_last_switched_planet", "");
            // Check if miners are in flight — that's why they're absent from all planets
            const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
            if (fleetReturnAt && Date.now() < fleetReturnAt) {
              const waitMin = Math.ceil((fleetReturnAt - Date.now()) / 60000);
              log(`Asteroid Miners absent from all planets — fleet in flight (~${waitMin}min). Clearing stale mission.`, "asteroid");
              GM_setValue("pending_mission", null);
              return;
            }
            log(`Asteroid Miner not found on ANY planet! Ships: ${shipDump}`, "error");
            stampDispatchFailIfMining(mission); // v2.95.0: farm/debris/rescue failure does not park the scanner
            await finishDispatch(false);
            return;
          }
        }
        } // end single-ship-type path (v2.14.0)

        await AntiDetection.sleep(1000 + Math.random() * 1500);
        if (offAbort("step1→2")) return;

        // Click "Next" — step 1 → step 2
        if (!await clickButtonWhenEnabled("Next", "step1→2")) {
          dumpButtons("step1-fail");
          // v2.66.6: without the legacy "Cannot find Next button" — the failure reason
          // (dead button vs missing button) was already printed by clickButtonWhenEnabled
          // one line above; the second message claimed the button "wasn't there",
          // even when it sat on the page disabled (misled the owner at 09:51).
          log("Step 1 failed — aborting the dispatch (details above).", "error");
            stampDispatchFailIfMining(mission); // v2.95.0: farm/debris/rescue failure does not park the scanner
          await finishDispatch(false);
          return;
        }

        // ═══ STEP 2: Wait for destination form ═══
        const step2Ready = await waitForStepChange(() => {
          return Array.from(document.querySelectorAll("a, button")).some(
            el => el.textContent.trim() === "Back" && el.offsetParent !== null
          );
        });
        if (!step2Ready) {
          dumpButtons("step2-timeout");
          log("Step 2 never loaded (no Back button after 8s)", "error");
            stampDispatchFailIfMining(mission); // v2.95.0: farm/debris/rescue failure does not park the scanner
          await finishDispatch(false);
          return;
        }
        log("Step 2 loaded (destination)", "fleet");
        dumpButtons("step2");

        // ── v2.66.5: check whether the form is TARGETING where the mission goes ──
        // Incident 2026-08-04 09:50: the form loaded WITHOUT the URL
        // parameters — the target fell back to the default (own planet 3:269:8 instead of
        // 3:269:16), target=source, the game greyed out Next and the wave was lost after 25 s
        // of waiting. The owner's dump showed it directly. The target coords live
        // in the #fleet2_target_x/y/z fields (markup confirmed live during
        // the FS measurement) — compare against the mission target and fix, BEFORE we click.
        try {
          const wantCoord = coordsFromFleetUrl(mission.fleetUrl);
          const fx = document.getElementById("fleet2_target_x");
          const fy = document.getElementById("fleet2_target_y");
          const fz = document.getElementById("fleet2_target_z");
          if (wantCoord && wantCoord.split(":").length === 3 && fx && fy && fz) {
            const [wg, ws, wp] = wantCoord.split(":");
            const have = `${fx.value}:${fy.value}:${fz.value}`;
            if (have !== `${wg}:${ws}:${wp}`) {
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              for (const [el, v] of [[fx, wg], [fy, ws], [fz, wp]]) {
                if (setter) setter.call(el, v); else el.value = v;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
              log(`[CEL] the form showed [${have}] while the mission flies to [${wg}:${ws}:${wp}] — I fixed the target fields (the URL didn't apply the parameters).`, "warn");
              // v2.97.4: fixing the coords alone is NOT enough when the form
              // opened with the default MOON target (active pair) - the target
              // type stayed "Moon" and the game rejected the send with a "There is
              // no planet or moons on this target" modal (incident 15.08 19:21: farm
              // from the moon [4:132:8] onto planets [4:406:x], step 3 kept
              // timing out in series). A mission with planet=1 in the URL ALWAYS flies to
              // a planet - pin the type with the same mechanism as rescue
              // (data-planet-type=1, skipping the sidebar).
              if (/[?&]planet=1(?:&|$)/.test(mission.fleetUrl || "")) {
                const inSidebarCel = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx-bot-panel");
                const planetBtn = [...document.querySelectorAll('[data-planet-type="1"]')].filter(el => !inSidebarCel(el))[0];
                if (planetBtn) {
                  planetBtn.click();
                  log("[CEL] target type pinned to PLANET (the form had started with the moon target).", "fleet");
                } else {
                  log("[CEL] could not find the target-type switch (data-planet-type=1) - if the game rejects the send, paste the [MOON DOM] dump.", "warn");
                }
              }
              await AntiDetection.sleep(700 + Math.random() * 500); // let the game recompute the route
            }
          }
        } catch {}

        // ── v2.26.0: the moon is a DESTINATION TYPE, not a link ──
        // Owner walked the form by hand and showed what the game actually does:
        // step 2's Destination panel offers planet / moon / debris for the SAME
        // coordinates, and step 3 then offers Transport / Deploy / Collect.
        // There is no moon link in the galaxy row to learn — which is why the
        // fleet save sat "cel nieznany" through every visit. Target the base
        // coords like any other fleet and pick the body here.
        if (mission.moonSave || mission.fleetSave) {
          // v2.28.0: the target body is decided at dispatch time and carried on
          // the mission, because "flee" and "home" are no longer fixed to moon
          // and planet — either can be the base. Old missions without the field
          // keep the pre-2.28 meaning.
          // v2.60.0: Fleet Save uses the same live-verified
          // body switch (data-planet-type=2) — the FS target is always the moon.
          const wantMoon = mission.targetBody ? mission.targetBody === "moon" : !mission.moonReturn;
          const panel = document.querySelector("#fleet2, .fleet2, .destination, [class*='destination']") || document.body;
          if (GM_getValue("ogamex_step2_markup_dumped", "") !== "1") {
            GM_setValue("ogamex_step2_markup_dumped", "1");
            log(`[MOON DOM] step-2 destination panel: ${(panel.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 1200)}`, "info");
          }
          // Candidates for the body switch, narrowed to the form: the sidebar's
          // own .planet-select/.moon-select are the PLANET SWITCHER and must not
          // be touched here — clicking those changes which planet we fly FROM.
          const inSidebar = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx-bot-panel");
          // v2.26.1: the live dump settled the markup — the switch is
          //   <a data-name="Moon" data-planet-type="2" class="moon-icon">
          // with 1=Planet, 2=Moon, 3=Debris. Match the DATA ATTRIBUTE, not a
          // regex over class names: "planet" appears in half the ids on this
          // page (#target_planet_type_name, .planet-coord, .planet-name), so
          // the fuzzy match for the RETURN leg could have grabbed a label
          // instead of the button and quietly left the target on the moon.
          const wantType = wantMoon ? "2" : "1";
          const byData = [...panel.querySelectorAll(`[data-planet-type="${wantType}"]`)]
            .filter(el => !inSidebar(el));
          const wanted = wantMoon ? /moon-icon/i : /planet-icon/i;
          const pick = byData[0] || [...panel.querySelectorAll("a, button")]
            .filter(el => el.offsetParent !== null && !inSidebar(el))
            .find(el => wanted.test(`${el.className || ""} ${el.getAttribute("data-name") || ""}`));
          if (pick) {
            pick.click();
            log(`[${missionTag("MOON SAVE")}] target: ${wantMoon ? "MOON" : "PLANET"} — clicked ${pick.tagName}.${(pick.className || "").toString().split(" ")[0] || "-"}`, "fleet");
            ThreatLog.add("RESCUE", `Target set: ${wantMoon ? "MOON" : "PLANET"}`);
            await AntiDetection.sleep(400 + Math.random() * 400);
          } else {
            log(`[MOON SAVE] did NOT find the ${wantMoon ? "moon" : "planet"} switch on step 2 — flying with the default target (that is PLANET). Panel dump above: send it over, I'll add the selector.`, "error");
            ThreatLog.add("ERROR", `Could not find the ${wantMoon ? "moon" : "planet"} switch on step 2 — default target (PLANET).`);
            // v2.60.0: for rescue (same coords, both bodies ours) flying with the
            // default target is a conscious continuation. For FS the default target = PLANET
            // at FOREIGN coords — nothing may be sent there. Abort.
            if (mission.fleetSave) {
              log("[FS] without the moon switch I do NOT send — the fleet stays home.", "error");
              GM_setValue("pending_mission", null);
              await AntiDetection.sleep(600 + Math.random() * 600);
              window.location.replace("/");
              return;
            }
          }
        }

        // ── v2.68.1: debris — I pick the "debris field" target MYSELF, I don't trust the URL ──
        // The collect link should set the target type, but the form can
        // lose the URL parameters (incident 09:50 4.08 — the [CEL] fix above
        // then only saves the coords). We know the body switch from the live
        // rescue dump: data-planet-type 1=Planet, 2=Moon, 3=Debris.
        if (mission.recycle) {
          const panel = document.querySelector("#fleet2, .fleet2, .destination, [class*='destination']") || document.body;
          const inSidebar = (el) => !!el.closest(".planet-select, .moon-select, .sidebar, nav, #ogx-bot-panel");
          const debrisBtn = [...panel.querySelectorAll("[data-planet-type='3']")].filter(el => !inSidebar(el))[0];
          if (debrisBtn) {
            debrisBtn.click();
            log("[DEBRIS] target: DEBRIS FIELD — clicked the data-planet-type=3 switch.", "fleet");
            await AntiDetection.sleep(400 + Math.random() * 400);
          } else {
            log(`[DEBRIS] no debris-field switch on step 2 — relying on the link parameters. Panel: ${(panel.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 400)}`, "warn");
          }
        }

        // ── v2.60.0: FS — flight speed (the main lever for FS length) ──
        // NOBODY has seen the slider's markup yet (note: "needs to be dumped
        // separately"), so: first attempts by MEANING (select with % options,
        // input[type=range], clickable "10%"), always dump the area around the form
        // to the log, and the gate below decides the outcome anyway — on the flight time,
        // which the GAME ITSELF shows. An unset speed ≠ a bad dispatch:
        // at worst the window won't fit in 2×T and the bot refuses to launch.
        if (mission.fleetSave || mission.airSave) { // v2.85.0: air escape flies slowly via the same code
          const pct = Math.max(1, Math.min(100, parseInt(mission.speedPercent) || 100)); // v2.74.1: the fork also has 3% and 5%
          let speedSet = false;
          // 1) a select whose options look like percentages (the "by text" pattern
          //    — the same one we use to set the expedition duration)
          for (const sel of document.querySelectorAll("select")) {
            const opts = [...sel.options];
            if (!opts.some(o => /%/.test(o.textContent || ""))) continue;
            const hit = opts.find(o => ((o.textContent || "").replace(/\s+/g, "").match(/^(\d{1,3})%$/) || [])[1] === String(pct));
            if (!hit) continue;
            sel.value = hit.value;
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            speedSet = true;
            break;
          }
          // 2) slider: scale 1-10 (classic 10%-100%) or 10-100
          if (!speedSet) {
            const r = document.querySelector("input[type='range']");
            if (r) {
              const min = parseFloat(r.min || "1"), max = parseFloat(r.max || "10");
              const value = max <= 10 ? Math.max(min, Math.round(pct / 10)) : Math.max(min, Math.min(max, pct));
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
              if (setter) setter.call(r, value); else r.value = value;
              r.dispatchEvent(new Event("input", { bubbles: true }));
              r.dispatchEvent(new Event("change", { bubbles: true }));
              speedSet = true;
            }
          }
          // 3) a clickable element with the exact text "NN%"
          if (!speedSet) {
            const el = [...document.querySelectorAll("a, button, span, div, label")]
              .find(e => e.offsetParent !== null && (e.textContent || "").trim() === `${pct}%`);
            if (el) { el.click(); speedSet = true; }
          }
          // 4) v2.66.8: ON THIS FORK the slider is a row of BARE numbers, without a % sign —
          // the owner's dump (04.08, step 2, Briefing section): "Speed:
          // 3 5 10 20 30 40 50 60 70 80 90 100" with the hundred highlighted.
          // We recognize the row by its full set of values (a parent whose children
          // have the texts "3", "10" and "50") — a bare "10" appears on the page
          // in a thousand other places and clicking on bare text would be roulette.
          if (!speedSet) {
            const txt = (e) => (e.textContent || "").trim();
            const hundreds = [...document.querySelectorAll("a, span, button, div, td, li")]
              .filter(e => txt(e) === "100" && e.offsetParent !== null && !e.closest("#ogx-bot-panel"));
            for (const h of hundreds) {
              const row = h.parentElement;
              if (!row) continue;
              const kids = [...row.children];
              const texts = kids.map(txt);
              if (!(texts.includes("3") && texts.includes("10") && texts.includes("50"))) continue;
              const target = kids.find(k => txt(k) === String(pct));
              if (target) { target.click(); speedSet = true; }
              break;
            }
          }
          // v2.63.0: the previous dump caught the page HEADER (the selector hit
          // document.body) — useless. The anchor is the target panel
          // (#target_planet_type_container — confirmed live at 16:36),
          // we dump its surroundings + a list of everything that looks like "NN%".
          if (!speedSet && GM_getValue("ogamex_fs_speed_dumped", "") !== "2") {
            GM_setValue("ogamex_fs_speed_dumped", "2");
            const dest = document.getElementById("target_planet_type_container");
            const host = (dest && (dest.closest("form") || dest.parentElement?.parentElement?.parentElement))
              || document.querySelector("#content, .content") || document.body;
            log(`[FS DOM] step 2 — area around the form (looking for the speed slider): ${(host.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 3000)}`, "error");
            const pctEls = [...document.querySelectorAll("a, span, div, li, button, option, label")]
              .filter(e => /^\s*\d{1,3}\s*%\s*$/.test(e.textContent || "")).slice(0, 12);
            log(pctEls.length
              ? `[FS DOM] elements with "%": ${pctEls.map(e => `${e.tagName}.${String(e.className).split(" ")[0] || "-"}#${e.id || "-"}[${(e.textContent || "").trim()}]`).join(", ")}`
              : "[FS DOM] there is NO element with a bare \"NN%\" on the page — the slider may be on another step or have a different form.", "error");
          }
          log(`[FS] speed ${pct}%: ${speedSet ? "set" : "NOT set (markup in the log — send it). The game will fly at the default."}`, speedSet ? "fleet" : "warn");
          // let the game recompute the flight time after the speed change
          await AntiDetection.sleep(1200 + Math.random() * 800);
        }

        // ── v2.10.0: learn cargo-per-miner from the confirmation page ──
        // OGameX shows the selected fleet's total cargo capacity here. Divide
        // by the miners we selected to learn one miner's capacity, which feeds
        // AsteroidYieldTracker.minersNeeded(). Only learn when we know how many
        // we sent (dispatchInfo.toSend) and the user hasn't pinned it in config.
        try {
          // v2.90.0: learn ONLY on miner flights — farm Heavy Cargo has
          // a different cargo capacity (463 750 vs 20 750) and only made noise with the
          // sanity guard ("Rejecting cargo reading…" on every attack).
          if (!mission.farm && !mission.expedition && !mission.recycle
              && !CONFIG.asteroidMining.cargoPerMiner && dispatchInfo.toSend > 0) {
            const cargoText = document.body.textContent;
            // "Cargo capacity: 1.234.567" / "Storage capacity" / "Ładowność"
            const cm = cargoText.match(/(?:cargo|storage|capacity|ladun|ładun|frachtraum|laderaum)\D{0,20}?([\d][\d.,\s]{2,})/i);
            if (cm) {
              const totalCargo = parseInt((cm[1] || "").replace(/[^\d]/g, ""), 10);
              if (Number.isFinite(totalCargo) && totalCargo > 0) {
                AsteroidYieldTracker.recordCargoPerMiner(totalCargo, dispatchInfo.toSend);
              }
            } else {
              log(`[CARGO?] couldn't parse cargo capacity on step 2 — verify markup to enable auto cargo learning`, "warn");
            }
          }
        } catch (e) { log(`Cargo learn error (non-fatal): ${e.message}`, "warn"); }

        // ── Capture flight time from step 2 (shown before sending) ──
        const step2Text = document.body.textContent;
        // Look for "Flight time: HH:MM:SS" or "Duration: HH:MM:SS" or countdown elements
        const ftMatch = step2Text.match(/(?:[Ff]light\s*(?:time|duration)|[Dd]uration|[Ff]lugdauer)[\s:]*(\d{1,2}):(\d{2}):(\d{2})/);
        if (ftMatch) {
          capturedFlightMs = (parseInt(ftMatch[1]) * 3600 + parseInt(ftMatch[2]) * 60 + parseInt(ftMatch[3])) * 1000;
          log(`Captured flight time from step 2: ${ftMatch[1]}h${ftMatch[2]}m${ftMatch[3]}s`, "fleet");
        }
        // v2.66.8: this fork labels the flight time "Duration of flight (one way):
        // 00:35" — MM:SS format (one colon), so the HH:MM:SS pattern above
        // NEVER caught it. Applies to ALL missions: mining finally
        // gets its flight time from the form, instead of reconstructing it from the bar after
        // dispatch. On longer flights the game may show H:MM:SS — the third
        // part is optional.
        if (!capturedFlightMs) {
          const fm2 = step2Text.match(/Duration\s*of\s*flight[^0-9]{0,40}?(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
          if (fm2) {
            capturedFlightMs = fm2[3] !== undefined
              ? (parseInt(fm2[1]) * 3600 + parseInt(fm2[2]) * 60 + parseInt(fm2[3])) * 1000
              : (parseInt(fm2[1]) * 60 + parseInt(fm2[2])) * 1000;
            log(`Captured flight time (Duration of flight): ${fm2[1]}:${fm2[2]}${fm2[3] !== undefined ? ":" + fm2[3] : ""} → ${Math.round(capturedFlightMs / 1000)}s one-way`, "fleet");
          }
        }
        // Also check for data attributes with flight duration
        if (!capturedFlightMs) {
          const durationEl = document.querySelector("[data-duration], [data-flight-time], [data-flight-duration]");
          if (durationEl) {
            const dur = parseInt(durationEl.dataset.duration || durationEl.dataset.flightTime || durationEl.dataset.flightDuration || "0");
            if (dur > 0) {
              capturedFlightMs = dur > 1e6 ? dur : dur * 1000; // seconds or ms
              log(`Captured flight duration from DOM: ${Math.round(capturedFlightMs/1000)}s`, "fleet");
            }
          }
        }
        // Also try plain time pattern like "12:34" or "1:23:45" near flight-related text
        if (!capturedFlightMs) {
          const timeEl = document.querySelector(".flight-time, .duration, [class*='flight'], [class*='duration']");
          if (timeEl) {
            const tm = timeEl.textContent.match(/(\d{1,2}):(\d{2}):(\d{2})/);
            if (tm) {
              capturedFlightMs = (parseInt(tm[1]) * 3600 + parseInt(tm[2]) * 60 + parseInt(tm[3])) * 1000;
              log(`Captured flight time from element: ${tm[1]}h${tm[2]}m${tm[3]}s`, "fleet");
            }
          }
        }

        // ── v2.99.0 CALIBRATION: pair (Δ systems, minutes) from a real flight ──
        // Mining missions only — one ship type (ASTEROID_MINER), 100%
        // speed, the same galaxy. Target from fleetUrl (x=g&y=s), launch from
        // the mission's launchAt (fallback: HomeBase.mining() — the same source
        // the planner uses to compute distances, so the mapping is consistent).
        if (capturedFlightMs > 0 && mission.type === "asteroid_mining_direct") {
          try {
            const calUrl = (mission.fleetUrl || "").match(/[?&]x=(\d+)&y=(\d+)/);
            const calFrom = mission.launchAt || HomeBase.mining();
            if (calUrl && calFrom && parseInt(calUrl[1]) === calFrom.galaxy) {
              FlightCalibration.record(Math.abs(parseInt(calUrl[2]) - calFrom.system), capturedFlightMs / 60000);
            }
          } catch (e) { log(`[KALIBRACJA] sample write failed (does not block the dispatch): ${e.message}`, "warn"); }
        }

        // ── v2.86.5: EVERY rescue carries a real flight time ──
        // The guard and the return count the landing from it, not from the assumption
        // "hop < 130 s" (13:41: a 38-min rescue — the guard would have stood down half
        // an hour before landing, and the fleet would sit on the planet unattended).
        if (mission.moonSave && capturedFlightMs > 0 && !mission.flightMs) {
          mission.flightMs = capturedFlightMs;
          GM_setValue("pending_mission", JSON.stringify(mission));
        }
        // ── v2.85.0: AIR ESCAPE — the arithmetic gate ──
        // Only a flight still in the air can be recalled — the flight time from step 2
        // must cover the "last attack arrival + buffer" window. A flight too short =
        // an honest refusal and the colony falls back to a normal rescue (swap > nothing).
        if (mission.airSave) {
          if (capturedFlightMs > 0) {
            mission.flightMs = capturedFlightMs;
            GM_setValue("pending_mission", JSON.stringify(mission));
            const neededMs = Math.max(0, (mission.holdUntilMs || 0) - Date.now()) + 60000;
            if (capturedFlightMs < neededMs) {
              log(`[AIR SAVE] flight ${Math.round(capturedFlightMs / 60000)} min SHORTER than the required ${Math.ceil(neededMs / 60000)} min (last arrival + buffer) — NOT sending into the air, the colony falls back to a normal rescue.`, "error");
              ThreatLog.add("ERROR", `Air escape cancelled: flight ${Math.round(capturedFlightMs / 60000)} min < required ${Math.ceil(neededMs / 60000)} min. Switching to a rescue onto the other body.`);
              AirSave.markFailed(mission.atCoords, "flight too short for the recall window");
              AirSave.save(null);
              GM_setValue("pending_mission", null);
              return;
            }
          } else {
            log("[AIR SAVE] could not read the flight time on step 2 — sending anyway (a slow Deploy to another colony is hours of flight vs minutes of attack arrival).", "warn");
          }
        }
        // ── v2.60.0: FS — the arithmetic gate on the REAL flight time ──
        // This is the heart of FS safety: the decision rests neither on an estimate nor
        // on unverified markup, but on the flight time the game itself
        // shows on step 2 (capturedFlightMs — the same reading mining
        // has used for months). A recalled fleet returns after 2×the delay, so the window
        // for the return must fit in 2×T minus a margin for the recall itself.
        // If it doesn't fit (or this is just a measurement) → we do NOT send, T is saved,
        // and the planner computes the launch from now on without entering the form.
        if (mission.fleetSave) {
          // v2.63.0: the 16:36 measurement showed that step 2 of this fork does NOT show
          // the flight time where mining reads it (capturedFlightMs=0).
          // So during a measurement we go to step 3 (mission + summary) —
          // WITHOUT touching "Send fleet" — and try to read the time there.
          // Still nothing → dump step 3 to the log and an honest refusal.
          if (mission.fsMeasure && !(capturedFlightMs > 0)) {
            if (await clickButtonWhenEnabled("Next", "fs-measure step2→3")) {
              await waitForStepChange(() => Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']")).some(el => {
                if (el.offsetParent === null) return false;
                const txt = (el.value || el.textContent || "").trim().toLowerCase();
                return txt.includes("send fleet");
              }), 12000);
              const t3 = document.body.textContent;
              const m3 = t3.match(/(?:[Ff]light\s*(?:time|duration)|[Dd]uration|[Cc]zas\s*lotu)[\s:]*(\d{1,2}):(\d{2}):(\d{2})/);
              if (m3) capturedFlightMs = (parseInt(m3[1]) * 3600 + parseInt(m3[2]) * 60 + parseInt(m3[3])) * 1000;
              // v2.66.8: this fork's format — "Duration of flight … MM:SS"
              if (!(capturedFlightMs > 0)) {
                const m3b = t3.match(/Duration\s*of\s*flight[^0-9]{0,40}?(\d{1,3}):(\d{2})(?::(\d{2}))?/i);
                if (m3b) capturedFlightMs = m3b[3] !== undefined
                  ? (parseInt(m3b[1]) * 3600 + parseInt(m3b[2]) * 60 + parseInt(m3b[3])) * 1000
                  : (parseInt(m3b[1]) * 60 + parseInt(m3b[2])) * 1000;
              }
              if (!(capturedFlightMs > 0)) {
                const el3 = document.querySelector("[class*='flight'], [class*='duration'], [id*='duration' i], [id*='flight' i]");
                const tm3 = el3 && (el3.textContent || "").match(/(\d{1,2}):(\d{2}):(\d{2})/);
                if (tm3) capturedFlightMs = (parseInt(tm3[1]) * 3600 + parseInt(tm3[2]) * 60 + parseInt(tm3[3])) * 1000;
              }
              if (capturedFlightMs > 0) {
                log(`[FS] flight time read on step 3: ${Math.round(capturedFlightMs / 60000)} min.`, "info");
              } else if (GM_getValue("ogamex_fs_step3_dumped", "") !== "1") {
                GM_setValue("ogamex_fs_step3_dumped", "1");
                const host3 = document.querySelector("#content, .content") || document.body;
                log(`[FS DOM] step 3 (looking for the flight time): ${(host3.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 3000)}`, "error");
              }
            }
          }
          if (capturedFlightMs > 0) FleetSave.noteFlightMs(capturedFlightMs);
          const windowMs = (mission.returnAtMs || 0) - Date.now();
          const maxMs = capturedFlightMs > 0 ? 2 * capturedFlightMs - 2 * FleetSave.LAUNCH_MARGIN_MS : 0;
          const fits = capturedFlightMs > 0 && windowMs > 0 && windowMs <= maxMs;
          if (mission.fsMeasure || !fits) {
            const hhmm = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
            const why = mission.fsMeasure
              ? (capturedFlightMs > 0
                ? `measurement done — flight time ${Math.round(capturedFlightMs / 60000)} min, max FS ${Math.round(Math.max(0, maxMs) / 60000)} min`
                : "measurement did NOT read the flight time on step 2 or 3 — send the [FS DOM] lines from the log")
              : !(capturedFlightMs > 0) ? "could not read the flight time from the form (speed dump above in the log)"
              : windowMs <= 0 ? "the return hour has already passed"
              : `window ${Math.round(windowMs / 60000)} min > max ${Math.round(maxMs / 60000)} min — launch is worth it at ${hhmm((mission.returnAtMs || 0) - maxMs)}`;
            // A failed flight-time read must not drive a measurement every 15 min
            // (2 navigations + the form each time) — the automation is postponed,
            // the "Measure route" button works right away.
            if (!(capturedFlightMs > 0)) GM_setValue("ogamex_fs_measure_at", String(Date.now() + 3 * 60 * 60 * 1000));
            log(`[FS] NOT sending: ${why}.`, mission.fsMeasure ? "success" : "warn");
            // v2.75.6: a refusal without a pause LOOPED the launch every tick (07.08 08:10–08:13:
            // 7× "Start FS" in 2.5 min, zero dispatches), and the reason went only to
            // the plain log — the journal showed the loop without an explanation.
            // Every non-measurement refusal: a 10-min pause + the reason to the journal.
            if (!mission.fsMeasure) {
              GM_setValue("ogamex_fs_fail_at", String(Date.now()));
              ThreatLog.add("FS", `NOT sending: ${why}. Next attempt in 10 min.`);
            }
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          // we're sending — store the measured T in the mission so the post-dispatch
          // stamp (markLaunched) has it at hand also on the navigation path
          mission.capturedFlightMs = capturedFlightMs;
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
        }

        await AntiDetection.sleep(800 + Math.random() * 1200);
        if (offAbort("step2→3")) return;

        // Click "Next" — step 2 → step 3
        if (!await clickButtonWhenEnabled("Next", "step2→3")) {
          dumpButtons("step2-fail");
          // v2.66.6: as in step 1 — the real reason is one line above.
          log("Step 2 failed — aborting the dispatch (details above).", "error");
            stampDispatchFailIfMining(mission); // v2.95.0: farm/debris/rescue failure does not park the scanner
          await finishDispatch(false);
          return;
        }

        // ═══ STEP 3: Wait for Send fleet button ═══
        const step3Ready = await waitForStepChange(() => {
          return Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']")).some(el => {
            if (el.offsetParent === null) return false;
            const txt = (el.value || el.textContent || "").trim().toLowerCase();
            return txt.includes("send fleet") || txt.includes("send") && txt.includes("fleet");
          });
        }, 12000);
        if (!step3Ready) {
          dumpButtons("step3-timeout");
          log("Step 3 never loaded (no Send fleet button after 12s)", "error");
            stampDispatchFailIfMining(mission); // v2.95.0: farm/debris/rescue failure does not park the scanner
          await finishDispatch(false);
          return;
        }
        log("Step 3 loaded (mission select)", "fleet");

        // ── v2.17.0: fleet save — pick "stay there", then take every resource ──
        if (mission.moonSave) {
          // Mission choice. The game tags each option with a class named after
          // the mission (seen live: A.mission-item.EXPEDITION,
          // A.mission-item.ASTEROID_MINING), so match on that and — when
          // nothing matches — DUMP what's on offer rather than click something
          // plausible. A wrong mission here flies the fleet somewhere else.
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          let picked = null, matched = null;
          for (const want of MoonSave.MISSION_CANDIDATES) {
            picked = missions.find(m => nameOf(m).includes(want));
            if (picked) { matched = want; break; }
          }
          if (picked) {
            log(`[${missionTag("MOON SAVE")}] mission: "${(picked.textContent || "").trim().slice(0, 30)}" (${picked.className})`, "fleet");
            // v2.21.0: this is the fact the automatic trigger waits for. Until
            // a real send has shown which "fly there and stay" mission this
            // build offers, arming an unattended fleet mover would be guessing
            // with the whole fleet as the stake. One save proves it, forever.
            if (matched !== "TRANSPORT") MoonSave.proveMission(matched, picked.className || "");
            ThreatLog.add("RESCUE", `Mission: ${(picked.textContent || "").trim().slice(0, 20)} (${matched})`);
            // v2.20.0: a transport UNLOADS and flies home, and with the moon at
            // the same coords "home" is minutes away — straight back onto the
            // planet, in time for the next wave. It stays as the last resort
            // (better on the moon for a few minutes than on the planet), but it
            // is the multi-wave watcher that then does the actual work.
            if (matched === "TRANSPORT") {
              log("[MOON SAVE] WARNING: this is a transport, not stationing — the fleet WILL RETURN to the planet after unloading. The multi-wave guard will pull it off every ~90 s, but with many waves check the game.", "error");
            }
            picked.click();
            await AntiDetection.sleep(500 + Math.random() * 500);
          } else {
            log(`[MOON SAVE] no stationing-type mission matched. Available: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"} — sending with the page default.`, "warn");
          }

          // Resources: the form has a per-resource "max" and an all-in-one
          // button (observed live as A.btn-all-res). Take everything — loot is
          // half the reason the attack is coming.
          const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
          if (allRes) {
            allRes.click();
            log(`[${missionTag("MOON SAVE")}] all resources loaded.`, "fleet");
          } else {
            const fulls = [...document.querySelectorAll("a.btn-res-full, .btn-res-full")];
            fulls.forEach(b => b.click());
            log(fulls.length
              ? `[MOON SAVE] loaded resources via ${fulls.length} per-resource max buttons.`
              : "[MOON SAVE] no resource-load button found — ships fly, resources stay.", fulls.length ? "fleet" : "warn");
          }
          await AntiDetection.sleep(400 + Math.random() * 400);
          await applyDeutReserve(missionTag("MOON SAVE")); // v2.74.0: fuel for the latecomers
        }

        // ── v2.60.0: FS — the Station mission + resources from the moon ──
        // The same proven pattern as rescue (mission-item by class/text,
        // btn-all-res), but TRANSPORT is a hard no here: if the recall fails,
        // the stationing fleet stays safe on our moon, while a transport
        // would unload and return home in the middle of the night — exactly into the window
        // FS is supposed to protect against.
        if (mission.fleetSave) {
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          let picked = null, matched = null;
          for (const want of MoonSave.MISSION_CANDIDATES) {
            if (want === "TRANSPORT") break; // for FS, transport is not a fallback
            picked = missions.find(m => nameOf(m).includes(want));
            if (picked) { matched = want; break; }
          }
          if (!picked) {
            log(`[FS] no stationing mission on step 3 — NOT sending. Available: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"}`, "error");
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          log(`[FS] mission: "${(picked.textContent || "").trim().slice(0, 30)}" (${matched})`, "fleet");
          picked.click();
          await AntiDetection.sleep(500 + Math.random() * 500);
          const allRes = document.querySelector("a.btn-all-res, .btn-all-res");
          if (allRes) { allRes.click(); log("[FS] resources from the moon loaded.", "fleet"); }
          await AntiDetection.sleep(400 + Math.random() * 400);
          await applyDeutReserve("FS"); // v2.74.0: fuel for the latecomers
        }

        // ── v2.68.1: debris — the "Collect" mission is clicked explicitly, or not at all ──
        // This build has A.mission-item.COLLECT (seen live in the
        // step3-clickables dump 4.08 22:12). Without a hit I do NOT send: the default
        // mission with the whole recycler hangar is a lottery, and the debris can wait.
        if (mission.recycle) {
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          const picked = missions.find(m => /COLLECT|HARVEST|RECYCL/.test(nameOf(m)));
          if (!picked) {
            log(`[DEBRIS] no Collect/Harvest mission on step 3 — NOT sending. Available: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"}`, "error");
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          log(`[DEBRIS] mission: "${(picked.textContent || "").trim().slice(0, 30)}" (${picked.className})`, "fleet");
          picked.click();
          await AntiDetection.sleep(500 + Math.random() * 500);
        }

        // ── v2.72.0: farm — the ATTACK mission is clicked explicitly, or not at all ──
        // So far the farm trusted the mission=8 URL parameter, and this form
        // can lose parameters (incident 09:50 4.08 — default target despite
        // the coords in the URL). mission=8 was never confirmed live on this
        // fork (the numbering is custom: expedition=1, asteroid=12). A wrong mission
        // = the fleet flies for who knows what. The pattern proven on debris:
        // mission-item by class/text, no hit → we do NOT send + a dump.
        if (mission.farm) {
          const missions = [...document.querySelectorAll(".mission-item, [class*='mission-item']")];
          const nameOf = (el) => `${el.className || ""} ${el.textContent || ""}`.toUpperCase();
          const picked = missions.find(m => /ATTACK|ATTACK/.test(nameOf(m)) && !/ACS|MISSILE|DESTR/.test(nameOf(m)));
          if (!picked) {
            log(`[FARM] no Attack mission on step 3 — NOT sending. Available: ${missions.map(m => `${(m.textContent || "").trim().slice(0, 20)}[${m.className}]`).join(", ") || "NONE"}`, "error");
            FarmState.clear();
            GM_setValue("ogamex_farm_cooldown_until", String(Date.now() + 30 * 60 * 1000));
            GM_setValue("pending_mission", null);
            await AntiDetection.sleep(600 + Math.random() * 600);
            window.location.replace("/");
            return;
          }
          log(`[FARM] mission: "${(picked.textContent || "").trim().slice(0, 30)}" (${picked.className})`, "fleet");
          picked.click();
          await AntiDetection.sleep(500 + Math.random() * 500);
        }

        // ── v2.14.0: expedition holding time ──
        // Step 3 of an expedition carries an extra "Expedition duration"
        // dropdown ("1 Hours", …). Match by the option TEXT, not by index or
        // value — we've never seen this select's markup, and a wrong value
        // would silently change how long the fleet sits in deep space.
        if (mission.expedition) {
          const want = String(Math.max(1, mission.holdingHours || 1));
          let done = false;
          for (const sel of document.querySelectorAll("select")) {
            const opts = [...sel.options];
            if (!opts.some(o => /\b\d+\s*(hour|hours|h|godz)/i.test(o.textContent || ""))) continue;
            const hit = opts.find(o => (o.textContent || "").replace(/\s+/g, " ").trim().match(/^(\d+)\b/)?.[1] === want);
            if (!hit) { log(`Expedition: no "${want}h" option (have: ${opts.map(o => (o.textContent || "").trim()).join(", ")}) — leaving the default.`, "warn"); break; }
            sel.value = hit.value;
            sel.dispatchEvent(new Event("input", { bubbles: true }));
            sel.dispatchEvent(new Event("change", { bubbles: true }));
            log(`Expedition duration set to ${hit.textContent.trim()}`, "fleet");
            done = true;
            break;
          }
          if (!done) log("Expedition: duration select not found — sending with the page default.", "warn");
          await AntiDetection.sleep(600 + Math.random() * 900);
        }
        dumpButtons("step3");

        await AntiDetection.sleep(800 + Math.random() * 1200);

        // Click "Send fleet" — dump all visible clickables for diagnostics
        let dispatchOk = false;
        const allClickables = Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']")).filter(el => el.offsetParent !== null);
        const clickableInfo = allClickables.map(el => {
          const txt = (el.value || el.textContent || "").trim().substring(0, 40).replace(/\s+/g, " ");
          return `"${txt}"[${el.tagName}.${el.className.split(" ").slice(0,2).join(".")} id=${el.id || "-"}]`;
        }).join(", ");
        log(`[step3-clickables] ${allClickables.length} elements: ${clickableInfo}`, "fleet");

        // Priority 1: exact "send fleet" text match
        // Priority 2: id/class containing "send-fleet" or "btn-send"
        // Priority 3: broader "send" in id/class (but NOT text-only "send" — too broad)
        const sendBtn = allClickables.find(el => {
          const txt = (el.value || el.textContent || "").trim().toLowerCase();
          return txt === "send fleet";
        }) || allClickables.find(el => {
          const txt = (el.value || el.textContent || "").trim().toLowerCase();
          return txt.includes("send fleet");
        }) || allClickables.find(el => {
          const id = (el.id || "").toLowerCase();
          const cls = (el.className || "").toLowerCase();
          return id.includes("send-fleet") || id.includes("btn-send") ||
                 cls.includes("send-fleet") || cls.includes("btn-send");
        });
        if (sendBtn) {
          log(`Send btn: ${sendBtn.tagName}.${sendBtn.className} id=${sendBtn.id || "-"} href=${sendBtn.href || 'none'} text="${(sendBtn.textContent||"").trim().substring(0,50)}"`, "fleet");
          // v2.10.23 — DOUBLE-SEND FIX. This used to be:
          //     sendBtn.click();
          //     sendBtn.dispatchEvent(new MouseEvent("click", {...}));
          // Both lines run the button's handler, so every dispatch fired the
          // fleet-send TWICE, milliseconds apart → two identical fleets to the
          // SAME coords. The first mined the asteroid ("Resource Obtained"),
          // the second arrived to nothing ("Asteroid Not Found") — 12 of 16
          // missions on 2026-07-20 were such duplicates.
          //
          // The bug is as old as v2.9.0 but was MASKED while the bot sent 100%
          // of miners per flight: the first send emptied the hangar, so the
          // duplicate had no ships and died server-side. v2.10.0 right-sizing
          // sends only part of the fleet, leaving miners home — so the second
          // click started succeeding. Hence "it suddenly broke".
          //
          // Stamp the target BEFORE clicking: the click often navigates away
          // instantly, so any code after it may never run. Marking intent first
          // means a replayed pending_mission hits the duplicate guard above.
          // v2.10.26: LAST-SECOND server recheck. The first check ran at the
          // start of the 3-step flow, ~10s ago — another machine/browser can
          // have sent a fleet in that window. Fetch-only (skipDom — the step-3
          // page may render our own chosen target as text).
          // v2.83.0: the toggle's last chance — OFF clicked during
          // steps 1-3 must stop the dispatch NOW, not after the fact.
          if (offAbort("Send fleet")) return;
          const flyingNow = (mission.expedition || mission.moonSave || mission.fleetSave) ? null : await fleetAlreadyFlyingTo(missionCoord, { skipDom: true });
          if (flyingNow) {
            log(`DUPLICATE BLOCKED (pre-click, server events via ${flyingNow}): a fleet is already en route to [${missionCoord}]. Aborting send.`, "warn");
            GM_setValue("pending_mission", null);
            await finishDispatch(false); // sets the wait/return timer — that fleet is ours from elsewhere
            return;
          }

          // v2.10.25: stamp BEFORE the click (navigation may kill everything
          // after it), in BOTH storages. capturedFlightMs (game's own display,
          // step 2) lets us block re-sends only until ARRIVAL + 2min buffer —
          // after arrival the asteroid is consumed, so a respawn at the same
          // coords is legitimately mineable (the flat 1h block skipped those).
          {
            const releaseAt = capturedFlightMs > 0 ? Date.now() + capturedFlightMs + 120000 : undefined;
            // v2.12.1: `farm` flag lets fleetSendSuccessfully tell a late-nav
            // farm send apart from a mining send even after pending_mission
            // was already cleared by finishDispatch (slow-navigation race).
            // v2.14.0: an expedition stamp must NOT look like an asteroid one —
            // writeLastSent feeds the same-target guard, so stamping [g:s:16]
            // would make the next wave (and any asteroid at those coords) look
            // like a duplicate. Record the kind and drop the coord.
            writeLastSent({
              url: mission.fleetUrl,
              coord: (mission.expedition || mission.fleetSave) ? null : missionCoord,
              at: Date.now(),
              releaseAt: (mission.expedition || mission.fleetSave) ? Date.now() : releaseAt,
              farm: !!mission.farm,
              expedition: !!mission.expedition,
              fleetSave: !!mission.fleetSave,
            });
            if (!mission.expedition && !mission.recycle && !mission.fleetSave && missionCoord && releaseAt) DispatchedAsteroids.release(missionCoord, releaseAt);
            // v2.39.1: a separate counter of OUR mining flights (parallel
            // flight limit). We stamp BEFORE the click — navigation can kill
            // everything that comes after it.
            if (!mission.expedition && !mission.farm && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
              MiningFlights.add(missionCoord, capturedFlightMs);
            }
          }
          sendBtn.click();

          await AntiDetection.sleep(3000);
          // v2.10.24: only a VISIBLE element with actual text counts as an
          // error. `[class*='error']` also matches hidden/empty error
          // containers baked into the page — a false positive here wiped the
          // duplicate-guard stamp (line below) after every send, killing the
          // guard exactly when it was needed.
          // v2.98.2: NEVER read your own panel as the game's response.
          // Incident 17.08 14:22 (real attack): a log entry "INCOMING…"
          // (class="log-entry error") fell into [class*='error'] and the
          // moon→planet rescue got a false DISPATCH FAILED even though the
          // game ACCEPTED the fleet — the bot wiped the duplicate stamp and
          // treated the rescue as failed. Symmetrically, [class*='success']
          // caught "log-entry success", so it could mask a REAL game refusal.
          const errorMsg = Array.from(document.querySelectorAll(".error, .alert-danger, [class*='error']"))
            .find(el => !el.closest("#ogx-bot-panel") && el.offsetParent !== null && el.textContent.trim().length > 0);
          const successMsg = Array.from(document.querySelectorAll(".success, .alert-success, [class*='success']"))
            .find(el => !el.closest("#ogx-bot-panel"));
          const fleetMovement = document.body.textContent.includes("fleet movement") ||
                                document.body.textContent.includes("Fleet movement");

          if (errorMsg) {
            log(`DISPATCH FAILED! Error: ${errorMsg.textContent.trim().substring(0, 100)}`, "error");
            if (mission.moonSave) ThreatLog.add("ERROR", `The game rejected the dispatch: ${errorMsg.textContent.trim().slice(0, 120)}`);
            // No fleet actually left — drop the duplicate-guard stamp so a
            // genuine retry to these coords isn't blocked for the next 10min.
            writeLastSent(null);
            // v2.39.1: this fleet never launched — take it off the mining
            // flight counter, otherwise a phantom would eat the limit until flight end.
            if (!mission.expedition && !mission.farm && !mission.moonSave && !mission.recycle && !mission.fleetSave) MiningFlights.dropLast();
            stampDispatchFailIfMining(mission); // v2.95.0: a farm/debris/rescue failure doesn't park the scanner
          } else if (successMsg || fleetMovement) {
            if (mission.moonSave) ThreatLog.add(mission.ferry ? "reading" : mission.moonReturn ? "RETURN" : "RESCUE", mission.ferry ? "FERRY: planet → moon sent." : "SENT — the game accepted the fleet.");
            if (mission.moonReturn) MoonSave.disarm("fleet and resources returned to the home planet");
            log(mission.moonReturn ? "RETURN COMPLETE — fleet and resources are flying from the moon to the planet. Mining and expeditions are back to work."
              : mission.moonSave ? "FLEET SAVED — everything moved to the moon."
              : mission.expedition ? "EXPEDITION FLEET SENT!"
              : mission.farm ? "FARM FLEET SENT!"
              : "FLEET SENT! All miners dispatched!", "success");
            GM_setValue("ogamex_dispatch_fail_at", "0");
            GM_setValue("ogamex_tried_planets", "[]"); // reset planet rotation
            GM_setValue("ogamex_last_switched_planet", "");
            dispatchOk = true;

            // Use captured flight time from step 2 (actual asteroid mining flight time)
            // (v2.11.0: farm sends don't pause anything — no return timer.)
            // v2.15.1: `expedition` joins `farm` here. An expedition wave was
            // setting ogamex_fleet_return_at (90min fallback — its flight time
            // isn't parseable from the expedition form), and the asteroid
            // scanner then paused for an hour and a half waiting for "miners"
            // that were never sent. Observed live: "FLEET SENT! All miners
            // dispatched!" right after an expedition send to [3:269:16].
            if (capturedFlightMs > 0 && !mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
              // Round trip = flight time * 2, add 1 min buffer for processing
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
              log(`Fleet returns in ~${minLeft}min (flight: ${Math.round(capturedFlightMs/60000)}min × 2)`, "fleet");
            } else if (!mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
              // Fallback: try parsing from page, but only accept asteroid-type
              const returnTime = parseFleetReturnTime();
              if (returnTime) {
                GM_setValue("ogamex_fleet_return_at", String(returnTime));
                const minLeft = Math.ceil((returnTime - Date.now()) / 60000);
                log(`Fleet returns at ${new Date(returnTime).toLocaleTimeString("en-GB")} (~${minLeft}min)`, "fleet");
              } else {
                // Last resort: use maxFlightMinutes as pessimistic estimate
                const fallbackMs = CONFIG.asteroidMining.maxFlightMinutes * 2 * 60 * 1000;
                GM_setValue("ogamex_fleet_return_at", String(Date.now() + fallbackMs));
                log(`Could not parse flight time. Estimated return in ~${CONFIG.asteroidMining.maxFlightMinutes * 2}min`, "fleet");
              }
            }
          } else {
            const bodySnippet = document.body.innerText.substring(0, 300).replace(/\s+/g, ' ');
            log(`Fleet click done but UNVERIFIED. Page: ${bodySnippet}`, "fleet");
            GM_setValue("ogamex_dispatch_fail_at", "0");
            GM_setValue("ogamex_tried_planets", "[]");
            GM_setValue("ogamex_last_switched_planet", "");
            dispatchOk = true; // assume success if no error
            // Still use captured flight time if available (mining only)
            if (capturedFlightMs > 0 && !mission.farm && !mission.expedition && !mission.moonSave && !mission.recycle && !mission.fleetSave) {
              const returnTime = Date.now() + capturedFlightMs * 2 + 60000;
              GM_setValue("ogamex_fleet_return_at", String(returnTime));
              log(`Estimated return in ~${Math.ceil((capturedFlightMs * 2 + 60000) / 60000)}min`, "fleet");
            }
          }
        } else {
          dumpButtons("step3-no-send");
          log("Cannot find 'Send fleet' button (step 3)", "error");
          if (mission.moonSave) ThreatLog.add("ERROR", "No Send fleet button on step 3 — the rescue did NOT fly.");
            stampDispatchFailIfMining(mission); // v2.95.0: a farm/debris/rescue failure doesn't park the scanner
        }

        // dispatchOk=true → all miners sent, stop scanning (wait for return)
        // dispatchOk=false → failed, resume scanning for next asteroid
        await finishDispatch(dispatchOk);
        return;
      }

      // ── Standard multi-step fleet dispatch ──
      if (mission.step === "select_ships" && page === "fleet") {
        const success = await FleetDispatcher.selectShipsAndNext(mission.shipType, mission.quantity);
        if (success) {
          mission.step = "set_target";
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
        } else {
          GM_setValue("pending_mission", null);
        }
      } else if (mission.step === "set_target" && page === "fleet") {
        const { galaxy, system, position } = mission.target;
        const success = await FleetDispatcher.setTargetAndNext(galaxy, system, position);
        if (success) {
          mission.step = "send_fleet";
          mission.timestamp = Date.now();
          GM_setValue("pending_mission", JSON.stringify(mission));
        } else {
          GM_setValue("pending_mission", null);
        }
      } else if (mission.step === "send_fleet" && page === "fleet") {
        const success = await FleetDispatcher.selectMissionAndSend(mission.missionId);
        if (success) {
          log(`Mission ${mission.type} dispatched!`, "success");
        }
        GM_setValue("pending_mission", null);
      } else if (mission.step === "select_ships_direct" && page !== "fleet" && mission.fleetUrl) {
        // Race condition: pending_mission was set but we haven't navigated to
        // fleet yet (scheduler tick fired before navigation). Navigate now.
        log(`Mission waiting for fleet page (on ${page}). Navigating to ${mission.fleetUrl}`, "fleet");
        mission.timestamp = Date.now(); // refresh to prevent expiry
        GM_setValue("pending_mission", JSON.stringify(mission));
        await AntiDetection.sleep(500 + Math.random() * 500);
        window.location.replace(mission.fleetUrl);
        return;
      } else {
        // Fall-through: we have a pending_mission but no branch matched.
        // This happens when the dispatch flow left a fleet-page step in
        // state but the user/bot navigated back to galaxy (e.g. after a
        // failed dispatch). Clear it immediately instead of looping for
        // 5 minutes waiting for the timestamp to expire.
        log(
          `Dropping stuck pending_mission (step=${mission.step}, page=${page})`,
          "warn"
        );
        GM_setValue("pending_mission", null);
      }
    } catch (err) {
      log(`Mission flow error: ${err.message}`, "error");
      GM_setValue("pending_mission", null);
    } finally {
      _handlingMission = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SCHEDULER: Main loop
  // ═══════════════════════════════════════════════════════════════

  let schedulerTimer = null;

  async function schedulerTick() {
    // v2.10.28: the watchdog heartbeat is stamped by the LEADER only (plus the
    // disabled case, so a disabled bot doesn't look dead). A passive tab
    // stamping it MASKED a dead leader: the leader's lock heartbeat (its own
    // interval) kept it leader while its dead scheduler chain never acted, the
    // passive tab kept last_tick_at fresh, and the 25min watchdog never fired
    // in ANY tab — silently dead bot, forever. With leader-only stamping a
    // dead leader chain lets the stamp go stale → every tab's watchdog reloads
    // → re-init re-elects a working leader.
    if (!CONFIG.enabled) {
      GM_setValue("ogamex_last_tick_at", String(Date.now()));
      return;
    }

    // v2.10.25: only the leader tab acts — every other tab is a passive viewer.
    if (!requireLeader("scheduler")) return;
    GM_setValue("ogamex_last_tick_at", String(Date.now()));

    // Handle any pending multi-page mission first
    await handlePendingMission();

    // v2.36.0: defence is no longer part of the tick — it has its own clock
    // (startDefenceLoop). Reason from the audit: jitter sleeps INSIDE the tick,
    // and the chain is serial, so "before every pause" didn't protect against
    // a pause that stops the whole clock.

    // v2.12.0: coffee breaks — full-bot pause with human macro-pacing.
    if (Humanizer.isOnBreak()) {
      log(`On break (~${Humanizer.breakLeftMin()}min left) — no activity.`, "delay");
      return;
    }
    if (Humanizer.maybeStartBreak()) return;

    // v2.10.27: background yield learning (30min throttle inside, fail-open).
    AsteroidYieldTracker.fetchReportsPeriodic().catch(() => {});

    // Sleep check
    if (AntiDetection.isSleepTime()) {
      log("Night mode active - sleeping until " + CONFIG.antiDetection.sleepEndHour + ":00 (local time)", "delay");
      return;
    }

    // v2.21.0: the threat read moved above the pause gates (see the defence
    // block after handlePendingMission). Only the learning side-effects run
    // here, once the bot is genuinely active.
    ThreatMonitor.check();

    // v2.13.0: grab the green "Online bonus" if it's on screen. Placed before
    // the keepalive reload (which returns) and before jitter (which can sleep
    // 15min inside the tick) so a visible bonus is taken promptly. No-ops in
    // ~microseconds when the button isn't there (single textContent scan).
    await OnlineBonus.run().catch(() => {});

    // v2.71.0: FERRY planet→moon — in moon mode it carries everything that
    // has accumulated on the planet every 2 h (shipyard production, deuterium,
    // fleet after an unusual episode). due() itself checks alert/guard/pending/
    // breaks, so a single call is enough here. If it created a mission —
    // we end the tick, handlePendingMission takes over from the next run.
    if (await MoonFerry.run().catch(() => false)) return;

    // v2.10.10 keepalive: guarantee a REAL page load at least every ~12min.
    // After "scan complete — no asteroids" the bot used to sit 45min on one
    // galaxy page with zero requests; the session could expire in that window
    // and every later range-AJAX silently returned the login page (= blind
    // bot, see scanRanges). A periodic reload keeps the session fresh AND
    // resets any wedged in-page state (stuck flags, dead timer chains,
    // browser tab throttling). During an active scan navigation happens every
    // few seconds anyway, so this only fires during long waits/cooldowns.
    {
      const lastPageLoad = parseInt(GM_getValue("ogamex_last_pageload_at", "0"));
      const pendingRaw = GM_getValue("pending_mission", null);
      const hasPending = pendingRaw && pendingRaw !== "null";
      if (!hasPending && lastPageLoad && Date.now() - lastPageLoad > 12 * 60 * 1000) {
        log("Keepalive: no page load for >12min — reloading to keep session alive.", "info");
        if (window.location.href.includes("fleetSendSuccessfully")) {
          // Don't re-trigger the post-send handler with stale dispatch data
          window.location.replace("/");
        } else {
          window.location.reload();
        }
        return;
      }
    }

    // ── v2.14.0: expedition waves go BEFORE mining ──
    // Not a priority statement — a mechanical one. AsteroidMiner.run() usually
    // ends by navigating to the next galaxy page, and once the page unloads the
    // rest of this tick never executes. Left at the end of the tick (where the
    // old ExpeditionManager sat) a wave would almost never fire while a scan is
    // running. ExpeditionRunner.run() is a cheap no-op until a wave is actually
    // due (pacing + slot checks), it never starts on top of a pending dispatch,
    // and the scan self-heals from being interrupted — so preempting one scan
    // step every ~2min is the cheapest correct arrangement.
    if (CONFIG.expeditions.enabled && !ExpeditionRunner.running) {
      // v2.48.0: expedition debris sits at position 16 of the base system and
      // nobody will come for it but us. Collecting yields to everything else
      // (see shouldVisit), so it doesn't compete with mining.
      if (DebrisCollector.shouldVisit()) { DebrisCollector.visit(); return; }
      await ExpeditionRunner.run();
      const pendingAfterExpo = GM_getValue("pending_mission", null);
      if (pendingAfterExpo && pendingAfterExpo !== "null") return; // wave in progress — mining waits one tick
    }

    // Run asteroid mining
    const scanState = ScanState.load();
    const scanActive = scanState?.active;

    // Jitter — skip when scan is actively running (don't delay mid-scan).
    // v2.12.3: also skip while the scan cooldown is ticking down. The cooldown
    // already IS an idle pause; a jitter rolled during it humanized nothing
    // (the bot was doing nothing anyway) and just pushed the next range check
    // 5-15min past cooldown expiry — observed 10min cooldowns stretching to
    // 20-25min of blindness while fresh hint ranges sat unscanned.
    const scanCooldownActive = (parseInt(GM_getValue("ogamex_scan_cooldown_until", "0")) || 0) > Date.now();
    if (!scanActive && !scanCooldownActive) await AntiDetection.jitter();
    if (CONFIG.asteroidMining.enabled && !AsteroidMiner.running) {
      // If a scan is active but we're not on the galaxy page (user navigated
      // away, or dispatch landed us elsewhere), resume by jumping to the next
      // queued system instead of letting the scan rot until 120min expiry.
      if (scanActive && GameState.getCurrentPage() !== "galaxy") {
        const next = scanState.queue?.[0];
        const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
        const minersInFlight = fleetReturnAt && Date.now() < fleetReturnAt;
        const pendingMission = GM_getValue("pending_mission", null);
        const dispatchInProgress = pendingMission && pendingMission !== "null";
        // v2.10.14: un-wedge the dead state "active scan + empty queue + off the
        // galaxy page". handleGalaxyScanStep (which finishes a sweep and sets the
        // cooldown) only runs ON the galaxy page; the stranded-resume below needs
        // a `next` system. So an exhausted queue reached while we're off-galaxy
        // (e.g. a dispatch that hit the flight budget left us on overview/
        // fleetSendSuccessfully without clearing ScanState) matches NEITHER this
        // branch nor the !scanActive one — the scheduler idles silently and only
        // the 12-min keepalive reload ticks, forever. Clearing the spent scan
        // lets the next tick's !scanActive path start a fresh one (deep fetch →
        // picks up current ranges & any new asteroids).
        if (!next && !dispatchInProgress) {
          // v2.12.4: this un-wedge used to clear WITHOUT a cooldown — after a
          // dispatch that consumed the queue (pruneFoundRange on a single
          // range) the very next tick re-swept the same still-advertised
          // range from scratch. Quiet cooldown instead; startNewScan deep-
          // fetches fresh ranges when it expires.
          endSweepWithCooldown("Active scan but queue empty & off galaxy page");
          return;
        }
        if (next && !minersInFlight && !dispatchInProgress && !AntiDetection.isSleepTime()) {
          log(`Scan stranded off galaxy page. Resuming at [${next.galaxy}:${next.system}]`, "asteroid");
          await AntiDetection.shortDelay();
          scanNavigate(`/galaxy?x=${next.galaxy}&y=${next.system}`, "stranded resume");
          return;
        }
      } else if (scanActive && GameState.getCurrentPage() === "galaxy") {
        // On galaxy page with active scan — resume if fleet has returned.
        // This fires when the bot waits on a galaxy page for fleet return and
        // the fleet comes back without a page navigation (no new init() call).
        const fleetReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
        const minersInFlight = fleetReturnAt && Date.now() < fleetReturnAt;
        if (!minersInFlight) {
          await AsteroidMiner.run();
        }
      } else if (!scanActive) {
        await AsteroidMiner.run();
      }
    }

    // v2.11.0: inactive farming (no-ops when disabled or when mining is ON)
    if (CONFIG.inactiveFarming?.enabled && !InactiveFarmer.running) {
      await InactiveFarmer.run();
    }

  }

  // ═══════════════════════════════════════════════════════════════
  //  DEFENCE LOOP  (v2.36.0) — its own clock, outside the scheduler
  // ═══════════════════════════════════════════════════════════════
  // Audit 2026-08-02, critical finding #1: the defence block lived inside the
  // scheduler tick, and AntiDetection.jitter() does `await sleep(5-15 min)`
  // INSIDE the tick. The chain is serial (`await schedulerTick(); scheduleNext();`),
  // so jitter stopped the whole clock — and for a dozen-odd minutes, several
  // times an hour, there was NOT A SINGLE mission-bar reading. Moving defence
  // "before the pauses" in v2.21.0 protected against coffee breaks and sleep,
  // because the tick returns from those; it doesn't return from jitter.
  //
  // ═══════════════════════════════════════════════════════════════
  //  DEFENCE WATCHDOG (v2.76.0) — who watches the watcher
  // ═══════════════════════════════════════════════════════════════
  // Twice in one week the defence SAW a threat and did nothing
  // about it: 03.08 an alert nobody dismissed, 07.08 a group attack
  // taken for a probe. The common denominator is none of that logic —
  // it's that INACTION LOOKS IDENTICAL TO SUCCESS. In both cases the
  // journal was simply silent.
  //
  // The watchdog flips that default state. When an alert is active and within
  // GRACE_MS there is NEITHER a fleet dispatch NOR an explicitly recorded
  // "I'm not moving, because…" decision, it treats this as a failure and screams: log, journal, notification.
  //
  // It does NOT move the fleet itself. If defence behaved differently than
  // anyone predicted, the last thing we want is a second automaton sending a
  // fleet in an unknown direction — that's what the human and the RESCUE
  // button are for. The watchdog's job is to make sure that human KNOWS.
  //
  // The contract works both ways: every path ending in "I'm not moving the
  // fleet" MUST leave a stamp via note(). No stamp = failure.
  const DefenceWatchdog = {
    KEY_DECISION: "ogamex_defence_decision",
    KEY_SINCE: "ogamex_defence_expect_since",
    KEY_ALERTED: "ogamex_defence_watchdog_alerted",
    GRACE_MS: 90 * 1000,       // detection (25 s) + page switches + the form
    REPEAT_MS: 5 * 60 * 1000,  // repeat the scream until nothing changes

    /** Explicit decision "I'm not moving the fleet, and here's why". */
    note(why) {
      try { GM_setValue(this.KEY_DECISION, JSON.stringify({ at: Date.now(), why })); } catch {}
    },
    _decision() {
      try { return JSON.parse(GM_getValue(this.KEY_DECISION, "null")); } catch { return null; }
    },

    // PURE verdict logic — no DOM, network or clock. Thanks to that it can be
    // tested without waiting for a real attack (test-nadzorca.js).
    verdict(s) {
      if (!s.expected) return { state: "off" };
      if (s.armed && s.saves > 0) {
        // v2.78.0: "we saved ONE colony" is not the same as "defence worked".
        // Without this condition a queue failure would be invisible: a guard
        // with a single save looks like success while the second colony sits
        // without a reaction. Exactly the class of error from 7.08 morning.
        if ((s.unhandled || 0) > 0 && s.aliveMs >= s.graceMs) {
          return { state: "STUCK", why: `colonies without reaction: ${s.unhandled}` };
        }
        return { state: "ok", why: "fleet evacuated" };
      }
      if (s.pendingRescue) return { state: "ok", why: "rescue in progress" };
      if (s.decisionAgeMs !== null && s.decisionAgeMs <= s.graceMs) return { state: "ok", why: "explicit decision" };
      if (s.aliveMs < s.graceMs) return { state: "waiting" };
      return { state: "STUCK" };
    },

    check() {
      const expected = !!(CONFIG.enabled && CONFIG.threatAlarm?.enabled
        && CONFIG.threatAlarm?.autoSave && ThreatMonitor.active());
      if (!expected) {
        // Alert cleared or defence disabled — restart the clock so the next
        // alert gets the full grace window.
        if ((parseInt(GM_getValue(this.KEY_SINCE, "0")) || 0)) {
          GM_setValue(this.KEY_SINCE, "0");
          GM_setValue(this.KEY_ALERTED, "0");
          // v2.78.0: alert cleared — the list of handled colonies loses its
          // meaning. Pending RETURNS stay: they happen right after the alert.
          try { RescueQueue.endAlarm(); } catch {}
        }
        return;
      }
      let since = parseInt(GM_getValue(this.KEY_SINCE, "0")) || 0;
      if (!since) { since = Date.now(); GM_setValue(this.KEY_SINCE, String(since)); }
      const w = MoonSave.watch() || {};
      const pend = String(GM_getValue("pending_mission", null) || "");
      const pendingRescue = pend !== "" && pend !== "null"
        && /moonSave|moonReturn|moon_save|moon_ferry/i.test(pend);
      const d = this._decision();
      const v = this.verdict({
        expected: true,
        armed: !!w.armed,
        saves: w.saves || 0,
        pendingRescue,
        decisionAgeMs: d && d.at ? Date.now() - d.at : null,
        aliveMs: Date.now() - since,
        graceMs: this.GRACE_MS,
        unhandled: RescueQueue.unhandledCount(w),
      });
      if (v.state !== "STUCK") return;
      const lastAlert = parseInt(GM_getValue(this.KEY_ALERTED, "0")) || 0;
      if (Date.now() - lastAlert < this.REPEAT_MS) return;
      GM_setValue(this.KEY_ALERTED, String(Date.now()));
      const secs = Math.round((Date.now() - since) / 1000);
      const ev = ThreatMonitor.events() || {};
      const msg = /kolonie bez reakcji/.test(v.why || "")
        ? `ALERT ACTIVE ${secs} s. One colony is saved, but ${(v.why.match(/\d+/) || ["?"])[0]} attacked colon(y/ies) NOT MOVED. `
          + `Target: [${(ev.targets || []).join(", ") || "?"}]. CHECK THE GAME — rescue manually with the RESCUE button on that colony.`
        : `ALERT ACTIVE ${secs} s and the fleet WAS NOT MOVED, with no recorded decision why. `
        + `Attacks: ${ev.attacks != null ? ev.attacks : "?"}`
        + `${ev.targets && ev.targets.length ? `, target [${ev.targets.join(", ")}]` : ""}. `
        + `CHECK THE GAME — if the fleet sits at home, use the RESCUE button.`;
      log(`[WATCHDOG] ${msg}`, "error");
      ThreatLog.add("ERROR", msg);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          new Notification("OGameX: DEFENCE STUCK — fleet not moved!", { body: msg, tag: "ogamex-watchdog" });
        }
      } catch {}
    },
  };

  // ═══════════════════════════════════════════════════════════════
  //  DEFENCE SELF-TEST (v2.77.0) — the bot checks itself
  // ═══════════════════════════════════════════════════════════════
  // "Will the bot behave correctly when attacked?" — that question is not
  // answered by reading the code (two audits missed the 07.08 bug) or by
  // tests on a copy of the logic. It is answered by running the REAL code
  // on known inputs.
  //
  // The self-test builds synthetic hostile fleet rows and runs them through
  // FleetMovements.classifyRow — the same function the real fleet-movement
  // list feeds every 30 s — then checks the watchdog's verdict. All in the
  // browser, on the installed bot version, without moving the fleet or
  // waiting for an attacker.
  //
  // What it does NOT test: the fleet dispatch itself (that's "ALERT TEST")
  // and markup the game hasn't shown us yet — which is why hostile rows from
  // real attacks still land in the log as [ATTACK DOM].
  const DefenceSelfTest = {
    _row(cls, srcCoord, dstCoord, { moon = false, eta = 360, id = "1" } = {}) {
      return `<table><tbody><tr class="${cls}" data-fleet-id="${id}">`
        + `<td class="fleet-source-coords"><a href="#">[${srcCoord}]</a> Napastnik</td>`
        + `<td><span data-remaining-seconds="${eta}">06:00</span></td>`
        + `<td>${moon ? '<img src="/img/moon-icon.png">' : ""}<a href="#">[${dstCoord}]</a> ${moon ? "Moon" : "Planeta"}</td>`
        + `</tr></tbody></table>`;
    },
    _parse(html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      return doc.querySelector("tr");
    },

    run({ manual = false, quiet = false } = {}) {
      const fails = [];
      const ok = [];
      const check = (name, cond) => { (cond ? ok : fails).push(name); };
      const own = new Set(["3:272:7", "3:280:4"]);

      try {
        // ── A. Classification of hostile rows (real classifyRow) ──
        const A = [
          ["classic attack", "row-mission-type-ATTACK row-hostile-mission", true],
          ["ACS/FEDERATION without a hostility class (07.08)", "row-mission-type-FEDERATION", true],
          ["hostile row named TRANSPORT", "row-mission-type-TRANSPORT row-hostile-mission", true],
          ["unknown mission type = attack", "row-mission-type-NOWY_TYP_2027", true],
          ["a probe is NOT an attack", "row-mission-type-ESPIONAGE row-hostile-mission", false],
          ["a plain transport is NOT an attack", "row-mission-type-TRANSPORT", false],
          // v2.86.2: incident 12.08 — an ALLY's Station (HOLD) triggered
          // an hour-long false alarm; the row-friendly-mission class beats the name.
          ["an ally's Station (HOLD friendly) is NOT an attack", "row-mission-type-HOLD row-friendly-mission", false],
          ["an ally's ACS defend (FEDERATION friendly) is NOT an attack", "row-mission-type-FEDERATION row-friendly-mission", false],
        ];
        for (const [name, cls, wantAttack] of A) {
          const r = FleetMovements.classifyRow(this._parse(this._row(cls, "3:248:11", "3:280:4", { moon: true })), own);
          check(`classification: ${name}`, !!r && r.attack === wantAttack);
        }

        // ── A2. Rescue target selection (v2.87.0 — PURE function, matrix) ──
        // Freezing the 13:10 lesson on the REAL function that run() calls.
        {
          const FH = { galaxy: 2, system: 277, position: 8 };
          const AP = { galaxy: 3, system: 272, position: 7 };
          const XX = { galaxy: 1, system: 1, position: 1 };
          const rrt = (o) => MoonSave.resolveRescueTarget(o);
          check("rescue target: explicit target from the list beats everything",
            rrt({ where: XX, watchAt: FH, manual: false, fleetHome: FH, activePair: AP }) === XX);
          check("rescue target: guarded colony before the fleet home",
            rrt({ where: null, watchAt: AP, manual: false, fleetHome: FH, activePair: null }) === AP);
          check("rescue target: AUTO without a target → FLEET HOME (13:10 lesson)",
            rrt({ where: null, watchAt: null, manual: false, fleetHome: FH, activePair: AP }) === FH);
          check("rescue target: auto without a fleet home → active pair",
            rrt({ where: null, watchAt: null, manual: false, fleetHome: null, activePair: AP }) === AP);
          check("rescue target: manual RESCUE → the operator's pair, not the fleet home",
            rrt({ where: null, watchAt: null, manual: true, fleetHome: FH, activePair: AP }) === AP);
          check("rescue target: nothing known → null (coordsOf will fill in the base)",
            rrt({ where: null, watchAt: null, manual: false, fleetHome: null, activePair: null }) === null);
        }

        // ── A3. Mid-air escape — the decision (real AirSave.decide) ──
        check("escape: both bodies of the pair under attack → air",
          AirSave.decide({ enabled: true, bodies: ["moon", "planet"], activePhase: null, failedAt: 0, now: Date.now() }) === "air");
        check("escape: one body → normal rescue",
          AirSave.decide({ enabled: true, bodies: ["moon"], activePhase: null, failedAt: 0, now: Date.now() }) === "swap");
        check("escape: flight already in progress → don't duplicate",
          AirSave.decide({ enabled: true, bodies: ["moon", "planet"], activePhase: "launched", failedAt: 0, now: Date.now() }) === "active");

        // ── A4. Mission bar parser (v2.88.1 — incident 15:24: bar without "Own") ──
        {
          const pb = (t) => ThreatMonitor.parseBar(t);
          const eq = (a, e) => !!a && a.total === e.total && a.own === e.own && a.foreign === e.foreign;
          check("bar: “2 Missions: 2 Hostile” (zero own) = 2 hostiles, not blindness",
            eq(pb("2 Missions: 2 Hostile Next: 04:15 Type: ACS Attack"), { total: 2, own: 0, foreign: 2 }));
          check("bar: “13 Missions: 12 Own” = 1 foreign (old arithmetic)",
            eq(pb("13 Missions: 12 Own"), { total: 13, own: 12, foreign: 1 }));
          check("bar: “5 Missions: 3 Own, 2 Hostile” = 2 hostiles (Hostile is the hard number)",
            eq(pb("5 Missions: 3 Own, 2 Hostile"), { total: 5, own: 3, foreign: 2 }));
          check("bar: an ally (Friendly) is not an enemy",
            eq(pb("4 Missions: 2 Own, 1 Hostile, 1 Friendly"), { total: 4, own: 2, foreign: 1 }));
          check("bar: page without a bar = null (blindness ≠ clean)",
            pb("Overview Server properties Online players: 283") === null);
          check("fleet home: a huge hangar outside the field next to a small home = ALARM",
            (FleetRecon.homeVerdict({ map: { "2:277:8": { total: 7.5e9, max: 7.5e9 }, "5:67:9": { total: 2e11, max: 2e11 } }, homeKey: "2:277:8" }) || {}).key === "5:67:9");
          check("fleet home: miners' moon next to the main fleet does NOT alarm",
            FleetRecon.homeVerdict({ map: { "5:67:9": { total: 2e11, max: 2e11 }, "3:272:7": { total: 7.5e9, max: 7.5e9 } }, homeKey: "5:67:9" }) === null);
        }

        // ── B. Attack target reading: coords + BODY (moon vs planet) ──
        const rm = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-ATTACK row-hostile-mission", "3:248:11", "3:280:4", { moon: true })), own);
        check("attack target: coordinates [3:280:4]", rm && rm.dst === "3:280:4");
        check("attack target: MOON recognized", rm && rm.dstBody === "moon");
        check("attack target: source [3:248:11]", rm && rm.src === "3:248:11");
        check("attack target: ETA 360 s", rm && rm.eta === 360);
        const rp = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-ATTACK row-hostile-mission", "3:248:11", "3:280:4", { moon: false })), own);
        check("attack target: PLANET recognized", rp && rp.dstBody === "planet");

        // ── C. Our own flight must not come out as foreign ──
        const mine = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-EXPEDITION", "3:272:7", "3:161:16")), own);
        check("own expedition recognized as OURS", mine && mine.mine === true);
        const foreign = FleetMovements.classifyRow(this._parse(this._row("row-mission-type-ATTACK row-hostile-mission", "3:248:11", "3:272:7", { moon: true })), own);
        check("attack ON us is not counted as ours", foreign && foreign.mine === false && foreign.attack === true);

        // ── D. Watchdog: silence during an alert must be a failure ──
        const G = DefenceWatchdog.GRACE_MS;
        const base = { expected: true, armed: false, saves: 0, pendingRescue: false, decisionAgeMs: null, aliveMs: 0, graceMs: G };
        check("watchdog: fresh alert = waiting", DefenceWatchdog.verdict({ ...base, aliveMs: 1000 }).state === "waiting");
        check("watchdog: fleet evacuated = OK", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1 }).state === "ok");
        check("watchdog: explicit decision = OK", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, decisionAgeMs: 1000 }).state === "ok");
        check("watchdog: SILENCE during an alert = failure", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G }).state === "STUCK");
        check("watchdog: guard with not a single save = failure", DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 0 }).state === "STUCK");

        // ── E. Rescue queue (v2.78.0) ──
        check("queue: a second attack on ANOTHER colony goes to rescue",
          RescueQueue.nextTarget({ targets: ["3:272:7", "2:151:8"], guarded: "3:272:7", done: [] }) === "2:151:8");
        check("queue: a guarded colony is not rescued twice",
          RescueQueue.nextTarget({ targets: ["3:272:7"], guarded: "3:272:7", done: [] }) === null);
        check("queue: a colony handled in this alert is skipped",
          RescueQueue.nextTarget({ targets: ["3:272:7", "2:151:8"], guarded: "3:272:7", done: ["2:151:8"] }) === null);
        check("watchdog: abandoned colony = failure (otherwise the queue silently breaks)",
          DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1, unhandled: 1 }).state === "STUCK");
        check("watchdog: full set of colonies handled = OK",
          DefenceWatchdog.verdict({ ...base, aliveMs: 5 * G, armed: true, saves: 1, unhandled: 0 }).state === "ok");
      } catch (e) {
        fails.push(`EXCEPTION in self-test: ${e.message}`);
      }

      const total = ok.length + fails.length;
      if (fails.length) {
        log(`[SELF-TEST] ${ok.length}/${total} OK — ${fails.length} FAILED: ${fails.join(" | ")}`, "error");
        ThreatLog.add("ERROR", `DEFENCE SELF-TEST FAILED (${fails.length}/${total}): ${fails.join(" | ")}. Defence may not work — don't leave the fleet at home.`);
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("OGameX: DEFENCE SELF-TEST FAILED", { body: fails.join(" | "), tag: "ogamex-selftest" });
          }
        } catch {}
        return false;
      }
      if (!quiet) log(`[SELF-TEST] defence checked: ${total}/${total} OK (hostile row classification, target & body reading, own flights, watchdog).`, "success");
      if (manual) ThreatLog.add("reading", `DEFENCE SELF-TEST: ${total}/${total} OK — classification, attack target reading and watchdog work on this bot version.`);
      return true;
    },
  };

  // A dedicated setInterval can't be starved: it doesn't depend on the tick,
  // jitter, humanizer breaks or the night window. It's the only way "defence
  // works 24 h" is true rather than a declaration.
  let defenceTimer = null;
  let defenceRunning = false;
  const DEFENCE_EVERY_MS = 30 * 1000;

  // ── v2.80.0: DEFENCE GAP SENSOR ──
  // 07.08, 12:11-12:23: the laptop stood twelve minutes without a single run
  // of the defence loop. The only trace was an informational line about a
  // session reload — something the owner would only learn by reading the log
  // himself. A gap in protection must be an EVENT: a ERROR entry goes to the
  // journal, and from there by push to the phone.
  //
  // We distinguish two cases because they carry different weight: a few-minute
  // hole with a supposedly working bot is a failure, while a multi-hour one is
  // simply a closed browser — and waking someone with a siren over that would
  // be noise that teaches them to ignore alerts.
  const DefenceUptime = {
    KEY: "ogamex_defence_last_tick",
    GAP_MS: 5 * 60 * 1000,        // below: normal operation (loop every 30 s)
    OFF_MS: 3 * 60 * 60 * 1000,   // above: the bot simply wasn't there

    // PURE classification — no clock, DOM or network (test-przerwa.js).
    classify(gapMs) {
      const mins = Math.round(gapMs / 60000);
      if (gapMs < this.GAP_MS) return { level: "ok", mins };
      if (gapMs > this.OFF_MS) return { level: "off", mins };
      return { level: "gap", mins };
    },

    tick() {
      const now = Date.now();
      const last = parseInt(GM_getValue(this.KEY, "0")) || 0;
      GM_setValue(this.KEY, String(now));
      if (!last || now <= last) return null;
      const v = this.classify(now - last);
      if (v.level === "ok") return null;
      if (v.level === "off") {
        log(`[DEFENCE] the bot was gone for ${Math.round(v.mins / 60)} h — nothing watched the fleet in that time.`, "warn");
        ThreatLog.add("reading", `The bot was off for ~${Math.round(v.mins / 60)} h (browser closed). Protection resumed.`);
        return v;
      }
      const msg = `GAP IN PROTECTION: for ${v.mins} min there was not a single run of the defence loop `
        + `(sleeping laptop, frozen background tab or closed browser). An attack in that window would NOT have been detected. `
        + `If you leave the computer, keep the game tab in front and set sleep to "Never" on mains power.`;
      log(`[DEFENCE] ${msg}`, "error");
      ThreatLog.add("ERROR", msg);
      return v;
    },
  };

  async function defenceTick() {
    if (defenceRunning) return;          // previous run still in progress
    // ── v2.69.1: THE TOWER ALWAYS WATCHES — bot OFF is observer mode ──
    // The 05.08 attack (487 bn ships) happened with the bot accidentally off
    // and left no data behind: [ATTACK DOM] dumps, journal and push lived in a
    // loop that OFF stopped. Detection is purely read-only — no reason for it
    // to go out. With OFF the loop still reads the movement list, writes the
    // journal, dumps hostile rows and sends notifications — but does NOT touch
    // the fleet (actuators sit behind a gate below; each of them also requires
    // CONFIG.enabled itself).
    if (!requireLeader("defence")) return; // only the leader tab moves the fleet
    defenceRunning = true;
    // v2.80.0: first measure whether we were there at all — only then look.
    // The stamp goes in EVERY tick, also with the bot OFF (the tower always
    // watches), because a gap in observation is a hole regardless of actuator state.
    try { DefenceUptime.tick(); } catch {}
    try { AudioKeepalive.ensure(); } catch {}
    try {
      // One-shot learning (galaxy visits) stays behind the pause — those would
      // make a "resting" bot navigate. The bar reading itself always runs,
      // because the attack depends on it.
      const resting = Humanizer.isOnBreak() || AntiDetection.isSleepTime();
      // v2.40.0: server first (mission type + target), then the decision. Two
      // light AJAX queries, the same ones the game itself makes every dozen-odd seconds.
      await ThreatMonitor.refreshEvents().catch(() => {});
      // v2.44.0: if after a minute of work we still have NOT A SINGLE event
      // reading from the server, run a one-shot diagnostic — otherwise silence
      // looks the same as calm.
      {
        const ticks = (parseInt(GM_getValue("ogamex_defence_ticks", "0")) || 0) + 1;
        GM_setValue("ogamex_defence_ticks", String(ticks));
        if (ticks >= 3 && !ThreatMonitor.events() && GM_getValue("ogamex_api_diag_done", "") !== "1") {
          GM_setValue("ogamex_api_diag_done", "1");
          log("[API TEST] after several runs still no event reading from the server — checking endpoints.", "warn");
          Ajax.diagnose().catch(() => {});
        }
      }
      ThreatMonitor.check({ emergencyOnly: resting });
      // v2.76.0: the watchdog looks BEFORE the actuators — it judges what
      // previous runs did (or didn't) do. Thanks to that it runs every tick,
      // no matter which actuator below cuts the tick short with its return.
      DefenceWatchdog.check();
      // v2.69.1: with the bot OFF we end at detection — fleet untouched.
      // returnHome doesn't check CONFIG.enabled on its own, so the gate
      // must be here, before anything can move.
      if (!CONFIG.enabled) return;
      // v2.55.0: if the previous tick switched the planet, finish the rescue here.
      if (MoonSave.resumeAfterSwitch()) return;
      if (await MoonSave.autoSaveOnThreat().catch(() => false)) return;
      if (await MoonSave.returnHome().catch(() => false)) return;
      await MoonSave.keepPlanetEmpty().catch(() => false);

      // v2.60.0: Fleet Save lives in the defence loop for the same reason the
      // loop exists: a recall in the middle of the night must not depend on
      // the scheduler, which sleeps in the night window and stalls on jitter.
      // Rescue takes priority — the FS tick itself yields during an active alert.
      // v2.85.0: the mid-air escape recall clock — lives in the defence loop
      // for the same reason as FS: a recall must not depend on the scheduler,
      // which sleeps in the night window and stalls on jitter.
      await AirSave.tick().catch((e) => { log(`[ESCAPE] tick error: ${e.message}`, "error"); });
      await FleetSave.tick().catch((e) => { log(`[FS] tick error: ${e.message}`, "error"); });

      // ── v2.39.0: when we SEE something, look more often ──
      // Confirmation requires two readings and the loop runs every 30 s — so
      // the decision could take a whole minute. With flights counted in minutes
      // that's within the norm, but half the warning window went to just
      // waiting for the next look. Since a candidate exists, we add an extra
      // reading after 10 s: confirmation drops from ~60 s to ~35 s; the
      // background traffic doesn't change — this only happens when we really saw something.
      // v2.86.0: the ~10 s rhythm also lasts 10 min AFTER the candidate
      // disappears — a decoy vanishes in seconds, and the real attack comes right behind it.
      // v2.86.1: the same for 5 min after a PROBE — a scan precedes an attack,
      // and a probe flies for seconds; whoever is watching us may strike soon.
      const highAlertAt = parseInt(GM_getValue("ogamex_high_alert_at", "0")) || 0;
      const spyAlertAt = parseInt(GM_getValue("ogamex_spy_alert_at", "0")) || 0;
      if ((parseInt(GM_getValue(ThreatMonitor.KEY_CANDIDATE, "0")) || 0)
          || Date.now() - highAlertAt < 10 * 60 * 1000
          || Date.now() - spyAlertAt < 5 * 60 * 1000) {
        setTimeout(() => { defenceTick().catch(() => {}); }, 10 * 1000);
      }
    } catch (err) {
      log(`[RESCUE] defence loop error: ${err.message}`, "error");
      ThreatLog.add("ERROR", `The defence loop threw an exception: ${err.message}`);
    } finally {
      defenceRunning = false;
    }
  }

  // v2.77.0: self-test on every script start — a freshly installed version
  // reports in the log whether its defense even recognizes an attack. Zero
  // cost, and it catches a regression in classification before an attacker does.
  function runSelfTestOnBoot() {
    setTimeout(() => {
      try {
        // v2.77.2: the bot reloads the page every dozen or so seconds (galaxy
        // scan), so a self-test on every boot spat out a dozen identical lines
        // per minute and drowned the real defense entries in them.
        // The check still ALWAYS runs (it's free) — only the success report
        // goes quiet: it speaks after a version change and once per 30 min.
        // A failure always shouts, because that's the only reason it exists.
        const KEY = "ogamex_selftest_last";
        const ver = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "?";
        let last = {};
        try { last = JSON.parse(GM_getValue(KEY, "{}")) || {}; } catch {}
        const quiet = last.ver === ver && last.ok === true &&
                      Date.now() - (last.at || 0) < 30 * 60 * 1000;
        const ok = DefenceSelfTest.run({ quiet });
        GM_setValue(KEY, JSON.stringify({ ver, ok, at: quiet && ok ? (last.at || Date.now()) : Date.now() }));
      } catch {}
    }, 4000);
  }

  // ═══════════════════════════════════════════════════════════════
  //  UPDATE WATCH (v2.88.1) — outdated-version watchdog
  // ═══════════════════════════════════════════════════════════════
  // INCIDENT 12.08 15:24: the fix for the attack from the Events panel (v2.88.0)
  // sat on main for 40 minutes while the bot kept running 2.87.3 —
  // Tampermonkey checks for updates once a day. A fixed bug protects
  // NOTHING until it runs. This watchdog compares @version with the repo
  // every 30 min and shouts (red log + journal with push) when the
  // local one is older. It updates nothing itself — that's TM's job.
  const UpdateWatch = {
    URL: "https://github.com/cthae/OgameX-Bot/raw/refs/heads/main/ogamex-bot.user.js",//"https://raw.githubusercontent.com/Mitjano/ogamex-userscript/main/ogamex-bot.user.js",
    KEY_AT: "ogamex_updwatch_at",
    KEY_NAG: "ogamex_updwatch_nag",

    // segment-wise comparison, not lexical (2.9 < 2.88)
    newer(remote, local) {
      const pa = String(remote).split(".").map(n => parseInt(n) || 0);
      const pb = String(local).split(".").map(n => parseInt(n) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0;
      }
      return false;
    },

    tick() {
      const last = parseInt(GM_getValue(this.KEY_AT, "0")) || 0;
      if (Date.now() - last < 30 * 60 * 1000) return;
      GM_setValue(this.KEY_AT, String(Date.now()));
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url: this.URL + "?t=" + Date.now(),
          timeout: 20000,
          onload: (r) => {
            try {
              const m = String(r.responseText || "").match(/@version\s+([\d.]+)/);
              if (!m) return;
              const remote = m[1];
              const local = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "0";
              if (!this.newer(remote, local)) return;
              log(`[UPDATE] Repo has v${remote}, this one runs v${local} — defense fixes do NOT work on this computer. Tampermonkey → Tools → Check for updates.`, "error");
              let nag = null; try { nag = JSON.parse(GM_getValue(this.KEY_NAG, "null")); } catch {}
              if (!nag || nag.ver !== remote || Date.now() - (nag.at || 0) > 6 * 60 * 60 * 1000) {
                GM_setValue(this.KEY_NAG, JSON.stringify({ ver: remote, at: Date.now() }));
                // the journal itself pushes ERROR to the phone (Notifier.fromJournal hook)
                ThreatLog.add("ERROR", `Bot OUTDATED: repo v${remote}, local v${local}. Update in Tampermonkey, otherwise defense fixes don't protect.`);
              }
            } catch {}
          },
        });
      } catch {}
    },
  };

  function startDefenceLoop() {
    runSelfTestOnBoot();
    if (defenceTimer) clearInterval(defenceTimer);
    defenceTimer = setInterval(() => { defenceTick().catch(() => {}); try { UpdateWatch.tick(); } catch {} }, DEFENCE_EVERY_MS);
    setTimeout(() => { defenceTick().catch(() => {}); }, 1500); // first run right away
    log(`Defense loop started (every ${DEFENCE_EVERY_MS / 1000}s, regardless of breaks and jitter).`, "info");
  }

  function startScheduler() {
    if (schedulerTimer) clearTimeout(schedulerTimer);
    // Randomized interval: 50-90 seconds (not a fixed 60s heartbeat)
    function scheduleNext() {
      const intervalMs = (50 + Math.random() * 40) * 1000;
      schedulerTimer = setTimeout(async () => {
        await schedulerTick();
        scheduleNext();
      }, intervalMs);
    }
    // v2.15.0: stamp the heartbeat NOW. While the bot is off nothing ticks, so
    // last_tick_at goes stale; re-enabling it then tripped the 25min watchdog
    // within seconds and reloaded the page for no reason (seen at 13:32 —
    // "Bot ENABLED" at :06, "scheduler chain dead. Reloading." at :08).
    GM_setValue("ogamex_last_tick_at", String(Date.now()));
    // First run after random 3-8 seconds
    setTimeout(() => {
      schedulerTick();
      scheduleNext();
    }, 3000 + Math.random() * 5000);
    log("Scheduler started", "info");
  }

  function stopDefenceLoop() {
    if (defenceTimer) { clearInterval(defenceTimer); defenceTimer = null; }
    log("Defense loop stopped.", "info");
  }

  function stopScheduler() {
    if (schedulerTimer) {
      clearTimeout(schedulerTimer);
      schedulerTimer = null;
    }
    log("Scheduler stopped", "info");
  }

  // ═══════════════════════════════════════════════════════════════
  //  UI PANEL
  // ═══════════════════════════════════════════════════════════════

  function createUI() {
    const panel = document.createElement("div");
    panel.id = "ogx-bot-panel";
    panel.innerHTML = `
      <style>
        #ogx-bot-panel {
          position: fixed;
          top: 10px;
          left: 10px;
          /* v2.65.3: 260px covered the game menu buttons (Overview, Resources…)
             on the owner's 13.6-inch screen. 232px ends before the menu. */
          width: 232px;
          background: rgba(0, 10, 30, 0.92);
          border: 1px solid #1a5276;
          border-radius: 8px;
          color: #e0e0e0;
          font-family: 'Segoe UI', Arial, sans-serif;
          font-size: 12px;
          z-index: 99999;
          box-shadow: 0 4px 20px rgba(0,0,0,0.6);
          user-select: none;
          /* v2.96.1: on a 13.6-inch MacBook the panel was TALLER than the
             window, and position:fixed doesn't scroll with the page - the
             bottom of the panel (defense journal, logs) was unreachable. The panel scrolls on its own. */
          max-height: calc(100vh - 20px);
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
        #ogx-bot-panel .header {
          background: linear-gradient(135deg, #1a5276, #0d2f4f);
          padding: 8px 12px;
          border-radius: 8px 8px 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          cursor: move;
          font-weight: bold;
          font-size: 13px;
          color: #5dade2;
        }
        #ogx-bot-panel .body { padding: 10px 12px; }
        /* v2.65.0: status strip — 5 lines answer 5 questions without clicking */
        #ogx-bot-panel .strip {
          padding: 7px 10px 5px;
          border-bottom: 1px solid #1a5276;
          font-size: 11px;
          line-height: 1.65;
        }
        #ogx-bot-panel .strip-row { display: flex; gap: 5px; align-items: baseline; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        #ogx-bot-panel .strip-row .ico { width: 16px; flex: none; text-align: center; }
        #ogx-bot-panel .strip-row .lbl { width: 62px; flex: none; color: #8fa8b8; }
        #ogx-bot-panel .strip-row .val { color: #d7e2ea; overflow: hidden; text-overflow: ellipsis; }
        #ogx-bot-panel .strip-row .val b { color: #fff; font-weight: 600; }
        #ogx-bot-panel .strip-row.ok .val { color: #6fcf97; }
        #ogx-bot-panel .strip-row.busy .val { color: #f2b25c; }
        #ogx-bot-panel .strip-row.alert .val { color: #ff6b6b; font-weight: 700; }
        #ogx-bot-panel .strip-row.dim .val { color: #7f8c8d; }
        /* v2.65.1: sections = settings, not state. Slim: 44px → ~26px per
           collapsed section; state is shown by the strip on top. */
        #ogx-bot-panel .section {
          margin-bottom: 4px;
          padding: 4px 8px;
          background: rgba(255,255,255,0.03);
          border-radius: 4px;
          border-left: 3px solid #1a5276;
        }
        #ogx-bot-panel .section.active { border-left-color: #27ae60; }
        #ogx-bot-panel .section.inactive { border-left-color: #7f8c8d; }
        #ogx-bot-panel .section-title {
          font-weight: normal;
          font-size: 11px;
          color: #b9c9d4;
          margin-bottom: 2px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        #ogx-bot-panel .section-title .mini-btn { padding: 1px 7px; font-size: 10px; }
        #ogx-bot-panel .status { font-size: 11px; color: #b7c4cd; }
        #ogx-bot-panel .status.on { color: #27ae60; }
        #ogx-bot-panel .status.off { color: #e74c3c; }
        #ogx-bot-panel .log-area {
          max-height: 200px;
          overflow-y: auto;
          font-size: 10px;
          font-family: monospace;
          background: rgba(0,0,0,0.3);
          padding: 6px;
          border-radius: 4px;
          margin-top: 4px;
        }
        #ogx-bot-panel .log-pinned {
          max-height: 60px;
          overflow-y: auto;
          font-size: 10px;
          font-family: monospace;
          background: rgba(80,0,0,0.3);
          border: 1px solid #e74c3c44;
          padding: 4px 6px;
          border-radius: 4px;
          margin-bottom: 4px;
        }
        #ogx-bot-panel .log-entry { margin: 1px 0; line-height: 1.4; }
        #ogx-bot-panel .log-entry.error { color: #e74c3c; }
        #ogx-bot-panel .log-entry.success { color: #27ae60; }
        #ogx-bot-panel .log-entry.delay { color: #7f8c8d; }
        #ogx-bot-panel .log-entry.asteroid { color: #f39c12; }
        #ogx-bot-panel .log-entry.expedition { color: #3498db; }
        #ogx-bot-panel .log-entry.fleet { color: #9b59b6; }
        #ogx-bot-panel .toggle-btn {
          padding: 4px 12px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: bold;
          font-size: 12px;
        }
        #ogx-bot-panel .toggle-btn.on {
          background: #27ae60;
          color: white;
        }
        #ogx-bot-panel .toggle-btn.off {
          background: #e74c3c;
          color: white;
        }
        #ogx-bot-panel .mini-btn {
          padding: 2px 8px;
          border: 1px solid #555;
          background: rgba(255,255,255,0.1);
          color: #ccc;
          border-radius: 3px;
          cursor: pointer;
          font-size: 11px;
        }
        #ogx-bot-panel .mini-btn:hover { background: rgba(255,255,255,0.2); }
        #ogx-bot-panel .minimize { cursor: pointer; font-size: 16px; color: #999; }
        #ogx-bot-panel .minimize:hover { color: #fff; }
      </style>

      <div class="header">
        <span>OGameX Assistant <span style="font-size:9px;color:#7f8c8d;font-weight:normal;" title="Script version per Tampermonkey — after a push to main it updates itself (CDN ~5 min).">v${(typeof GM_info !== "undefined" && GM_info?.script?.version) || "?"}</span></span>
        <div>
          <button id="ogx-toggle" class="toggle-btn ${CONFIG.enabled ? "on" : "off"}">${CONFIG.enabled ? "ON" : "OFF"}</button>
          <span class="minimize" id="ogx-minimize">_</span>
        </div>
      </div>
      <div class="strip" id="ogx-strip">
        <div class="strip-row" id="ogx-strip-def"><span class="ico">🛡</span><span class="lbl">Defense</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-min"><span class="ico">⛏</span><span class="lbl">Mining</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-exp"><span class="ico">🚀</span><span class="lbl">Expeditions</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-fs"><span class="ico">🌙</span><span class="lbl">Fleet Save</span><span class="val">—</span></div>
        <div class="strip-row" id="ogx-strip-llm"><span class="ico">🤖</span><span class="lbl">Gemini</span><span class="val">—</span></div>
      </div>
      <div class="body" id="ogx-body">
        <div class="section ${CONFIG.asteroidMining.enabled ? "active" : "inactive"}" id="ogx-asteroid-section">
          <div class="section-title">
            <span>Settings: Mining</span>
            <button class="mini-btn" id="ogx-asteroid-toggle">${CONFIG.asteroidMining.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-asteroid-status">Idle</div>
          <div class="status" id="ogx-asteroid-sizing" style="font-size:10px;color:#f39c12;margin-top:3px;">Mode: — | miners/mission: — | cargo/miner: — | est. asteroid: —</div>
          <div class="status" id="ogx-asteroid-locks" style="font-size:10px;color:#7f8c8d;margin-top:3px;" title="Which tab runs the bot + coords currently locked against re-dispatch (frees at fleet arrival, or after 1h if arrival unknown).">Tab: —</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="MOON = every routine dispatch (mining, expeditions, debris) starts from the base moon — the phalanx scans only planets, so flights from the moon are invisible and no snipe can be set on the fleet's return (attack 05.08). Fleet, miners, recyclers and deuterium must LIVE on the moon — ferry from the planet with the SAVE button. Rescue and FS have their own body logic.">Dispatch start (phalanx!)</span>
              <button class="mini-btn" id="ogx-base-body">${CONFIG.baseBody === "moon" ? "MOON" : "PLANET"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="FERRY: every 2 h automatically carries EVERYTHING (fleet, resources, deuterium minus the reserve) from the active planet to its moon on a Deploy mission. OFF = the bot NEVER moves the fleet on its own — moves only manually (SAVE / Deploy). Works only in moon mode.">FERRY planet→moon</span>
              <button class="mini-btn" id="ogx-ferry-toggle">${CONFIG.moonFerry?.enabled ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Fixed launch point for MINERS, e.g. 3:272:7 — before each asteroid dispatch the bot switches to this body on its own (the moon in MOON mode). Empty = miners launch from wherever you currently are. Remember: miners and deuterium for fuel must PHYSICALLY be on this body.">Miners start (g:s:p)</span>
              <input id="ogx-cfg-mining-from" type="text" placeholder="empty = where I am now" value="${CONFIG.asteroidMining.launchFrom ? `${CONFIG.asteroidMining.launchFrom.galaxy}:${CONFIG.asteroidMining.launchFrom.system}:${CONFIG.asteroidMining.launchFrom.position}` : ""}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="How many miners to send on ONE flight. 0 = send all available in a single wave. This overrides the auto cargo/est formula.">Miners per flight (0=all)</span>
              <input id="ogx-cfg-miners" type="number" min="0" step="1" value="${CONFIG.asteroidMining.minersPerMission}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Budget of miners to commit across simultaneous flights. The bot launches floor(total / per-flight) flights, then waits for returns. e.g. 100000 total / 50000 per = 2 flights. 0 = no limit (only fleet slots).">Total miners to use (0=∞)</span>
              <input id="ogx-cfg-total" type="number" min="0" step="1" value="${CONFIG.asteroidMining.totalMinersToUse}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Cargo capacity of ONE asteroid miner. 0 = auto-learn from the fleet page. Set it to enable smart sizing now.">Cargo / miner (0=auto)</span>
              <input id="ogx-cfg-cargo" type="number" min="0" step="1" value="${CONFIG.asteroidMining.cargoPerMiner}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Typical resources on one asteroid (sum metal+crystal+deut, from your past mission reports). 0 = auto-learn. With this + cargo set, the bot sends only ceil(res/cargo×buffer) miners.">Est. asteroid res. (0=auto)</span>
              <input id="ogx-cfg-est" type="number" min="0" step="1000" value="${CONFIG.asteroidMining.expectedResourcesPerAsteroid}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Set cargo + est → sends only what's needed. Or just set a miners cap.</div>
          </div>
        </div>

        <div class="section ${CONFIG.inactiveFarming.enabled ? "active" : "inactive"}" id="ogx-farm-section">
          <div class="section-title">
            <span>Settings: Farming</span>
            <button class="mini-btn" id="ogx-farm-toggle">${CONFIG.inactiveFarming.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-farm-status">Idle</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Which ship attacks inactive planets. Light Cargo / Battleship are often faster than Heavy Cargo (slot frees sooner = more attacks); Battleship survives leftover defence.">Ship type</span>
              <select id="ogx-farm-ship" style="width:120px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
                ${["LIGHT_CARGO", "HEAVY_CARGO", "BATTLESHIP"].map(s => `<option value="${s}" ${(CONFIG.inactiveFarming.shipType || "HEAVY_CARGO") === s ? "selected" : ""}>${s.replace("_", " ")}</option>`).join("")}
              </select>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Ships sent per attack on one inactive planet.">Ships / attack</span>
              <input id="ogx-farm-hc" type="number" min="1" step="1" value="${CONFIG.inactiveFarming.hcPerFlight}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="System ranges to sweep, comma-separated. Example: 3:100-200, 3:250-300. Every (i)/(I) inactive planet found is attacked; (v)/(p)/(b) skipped.">Ranges</span>
              <input id="ogx-farm-ranges" type="text" placeholder="3:100-200" value="${escapeHTML(CONFIG.inactiveFarming.ranges || "")}" style="width:120px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Fixed launch point for ATTACKS, e.g. 3:269:8 — before each attack the bot switches to this pair on its own (the moon in MOON mode), so you can farm another galaxy without moving the fleet. Empty = the attack launches from wherever you currently are. Ships must PHYSICALLY be on this body.">Farming start (g:s:p)</span>
              <input id="ogx-farm-from" type="text" placeholder="empty = where I am now" value="${CONFIG.inactiveFarming.launchFrom ? `${CONFIG.inactiveFarming.launchFrom.galaxy}:${CONFIG.inactiveFarming.launchFrom.system}:${CONFIG.inactiveFarming.launchFrom.position}` : ""}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="ON = sequential mode: each pass sweeps the ENTIRE range system by system (1→end) and attacks targets in the order encountered — no laps around the base and no loot sorting (looks predictable, but fat targets get no priority). OFF = loot priority (v2.97): fast laps over known systems + fattest targets first — from the outside it looks like hopping between random players. The rank filter, blacklist and loot threshold work in BOTH modes. Switching restarts the current pass.">Sequentially one by one</span>
              <button class="mini-btn" id="ogx-farm-seq">${CONFIG.inactiveFarming.sequentialSweep === true ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="A target with a KNOWN average loot below the threshold is skipped (the slot and the attack limit go to fatter targets). Targets with no loot history are attacked normally — that's how the base learns. 0 = no threshold. Example: 500000000000 = half a trillion.">Min. target loot (0=off)</span>
              <input id="ogx-farm-minprofit" type="number" min="0" step="1000000000" value="${CONFIG.inactiveFarming.minTargetProfit || 0}" style="width:120px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Don't re-attack the same planet within this many minutes. With “Sweep anew” ON this clock barely works — locks are released at the start of each pass anyway.">Target cooldown (min)</span>
              <input id="ogx-farm-cooldown" type="number" min="1" step="10" value="${CONFIG.inactiveFarming.targetCooldownMin}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="After reaching the end of the range the bot releases ALL locks and attacks the same players again on the next lap. The pace is then set by the sweep length (about 2 h for 499 systems) plus a 15 min break, not the cooldown clock. OFF = old behavior: a target locked for “Target cooldown” minutes regardless of laps.">Sweep anew</span>
              <button class="mini-btn" id="ogx-farm-repeat">${CONFIG.inactiveFarming.repeatEachSweep !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Keep this many fleet slots unused (for mining / manual play). Limit shown on the Fleet page as 'Fleets: X/37'.">Slot reserve</span>
              <input id="ogx-farm-reserve" type="number" min="0" step="1" value="${CONFIG.inactiveFarming.slotReserve}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Attack ONLY inactives with rank ≤ N (rank from the player tooltip in the galaxy, e.g. “Ranking: 2.881” = 2881). Players at the bottom of the rank have empty colonies — attacking them wastes a slot and flight time. 0 = no filter (old behavior). A target with an UNREAD rank is attacked normally, and the journal shouts [FARM RANK DOM].">Max target rank</span>
              <input id="ogx-farm-maxrank" type="number" min="0" step="100" value="${CONFIG.inactiveFarming.maxTargetRank ?? 800}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="A full range scan refreshes the TARGET BASE every this many hours. Between full scans the bot circles ONLY the systems with known targets within the rank limit — a lap takes minutes instead of hours, so fat targets get hit much more often. Statuses refresh on every visit, and entries unseen for 7 days fall out of the base on their own.">Full scan every (h)</span>
              <input id="ogx-farm-refresh" type="number" min="1" step="1" value="${CONFIG.inactiveFarming.dbRefreshHours ?? 12}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <button class="mini-btn" id="ogx-farm-dbdump" style="width:100%;margin-top:4px;" title="Prints the whole target base to the journal: coords, player, rank, when last seen — sorted by rank. Doesn't move the fleet.">SHOW TARGET BASE</button>
            <button class="mini-btn" id="ogx-farm-topdump" style="width:100%;margin-top:4px;" title="Prints the TOP 15 targets by average loot (EMA from the Plunder Journal) + threshold and median to the journal. The base learns on its own: journal fetch every 15 min + every player profile opening.">TOP TARGETS (loot)</button>
            <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">The full scan builds the base of inactives; then fast laps hit only targets with rank ≤ the limit. Mining has priority — farming works in the windows when miners are in flight.</div>
          </div>
        </div>

        <div id="ogx-threat-banner" style="display:none;margin-bottom:8px;padding:8px;border-radius:4px;background:rgba(192,57,43,0.25);border:1px solid #e74c3c;color:#ff8a80;font-weight:bold;font-size:11px;line-height:1.4;"></div>

        <div class="section" id="ogx-threat-section">
          <div class="section-title">
            <span>Settings: Defense</span>
            <button class="mini-btn" id="ogx-threat-toggle">${CONFIG.threatAlarm.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-threat-status">—</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <button class="mini-btn" id="ogx-moonsave-now" style="width:100%;background:#7b241c;border-color:#e74c3c;color:#fff;font-weight:bold;" title="Moves the ENTIRE fleet and ALL resources to the OTHER body at the same coords: from planet to moon or from moon to planet, depending on where the fleet is. The attacker picks the target at launch and can't change it in flight, so the fleet on the other body is outside that strike.">SAVE FLEET → other body</button>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:4px 0 2px;font-size:10px;color:#bbb;">
              <span title="When a foreign fleet appears in the mission bar, the bot itself sends the ENTIRE fleet and ALL resources to the moon. It also reacts to espionage probes — that's why it works together with the automatic return.">Auto-save on attack</span>
              <button class="mini-btn" id="ogx-auto-save">${CONFIG.threatAlarm.autoSave ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="When the alert fades (10 min without foreign fleets), the bot pulls the fleet and resources back to the planet so mining and expeditions can resume. Without this a false alert would park the economy on the moon for good.">Auto-return after alert</span>
              <button class="mini-btn" id="ogx-auto-return">${CONFIG.threatAlarm.autoReturn ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="When, during an ongoing alert, an attack comes in on ANOTHER colony, the bot evacuates it too, without touching the first guard. Returns go one after another. OFF = behavior before v2.78.0 (second colony without a reaction).">Rescue queue (2nd colony)</span>
              <button class="mini-btn" id="ogx-rescue-queue">${CONFIG.threatAlarm.rescueQueue !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="An attack on BOTH bodies of one pair at once (planet + moon, e.g. a Death Star “destroy moon” + an attack on the planet): evacuation within the pair doesn't save the fleet, so the bot sends EVERYTHING on a slow Deploy to the nearest other colony and RECALLS after the attacks pass — a fleet in flight is untouchable, and recalling a flight from the moon is invisible to the phalanx. OFF = behavior before v2.85.0.">Air escape (both bodies)</span>
              <button class="mini-btn" id="ogx-air-save">${CONFIG.threatAlarm.airSave !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="The tab plays an inaudible sound, so the browser doesn't freeze it or throttle its timers while it's in the background. It will NOT stop system sleep or a closed laptop lid — set that in Windows power options (“Sleep: Never” on AC power). Side effect: a speaker icon on the tab.">Don't let the tab freeze</span>
              <button class="mini-btn" id="ogx-keep-awake">${CONFIG.threatAlarm.keepAwake !== false ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="How much deuterium STAYS on the body on rescue and Fleet Save — fuel for the fleet that returns later (e.g. from an expedition) and will have to flee on its own. 0 = take everything.">Deuterium reserve</span>
              <input id="ogx-deut-reserve" type="number" min="0" step="100000000" value="${CONFIG.threatAlarm.deutReserve ?? 100000000000}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <button class="mini-btn" id="ogx-moonback-now" style="width:100%;margin-top:4px;background:#1a5276;border-color:#2e86c1;color:#fff;" title="Pulls the fleet and resources from the body they fled to back to the one they launched from. Needed after a manual rescue — the bot doesn't undo those on its own.">RETURN TO BASE</button>
            <button class="mini-btn" id="ogx-selftest" style="width:100%;margin-top:4px;" title="Runs synthetic hostile rows through the bot's REAL classifier (the same one fed by the fleet movement list) and checks the supervisor's verdict. Doesn't move the fleet, costs nothing, takes a fraction of a second. Answers the question “will this bot version recognize an attack”, without waiting for an attacker.">DEFENSE AUTOTEST (without moving the fleet)</button>
            <button class="mini-btn" id="ogx-threat-sim" style="width:100%;margin-top:4px;" title="Runs a SYNTHETIC attack on the base through the real defense machinery: candidate → confirmation ~25-35 s → EVACUATION of the entire fleet and resources to the other body → after ~2 min the alert fades and the fleet returns automatically. Cost: a few minutes of mining and two short flights. This is a full dress rehearsal of the automaton without waiting for the enemy.">ALERT TEST (attack simulation)</button>
            <button class="mini-btn" id="ogx-threat-sim-blind" style="width:100%;margin-top:4px;" title="Replays EXACTLY the attack scenario from 12.08 13:10: the movement list and server events clean, only the mission bar sees +1 foreign fleet (that's what attacks from your own system look like). Tests the whole blind path: bar cache → candidate → confirmation → rescue to the FLEET'S HOME → guard → return.">BLIND BAR TEST (attack from your system)</button>
            <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
              <label style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#bbb;">
                <span title="Push to your phone via ntfy.sh on attack, evacuation, defense error and return. Install the ntfy app (Google Play / App Store), add a subscription to the topic shown below — and that's it. A randomly named topic works like a password: don't share it.">Push to phone (ntfy)</span>
                <button class="mini-btn" id="ogx-ntfy-toggle">—</button>
              </label>
              <div class="status" id="ogx-ntfy-topic" style="font-size:9px;user-select:text;cursor:pointer;" title="Click to copy the topic name to the clipboard.">—</div>
              <button class="mini-btn" id="ogx-ntfy-topic-set" style="width:100%;margin-top:3px;" title="The ntfy topic is drawn SEPARATELY on each computer and browser (it lives in Tampermonkey storage, which doesn't sync). Two computers = two different topics, and the phone listens to only one — that's why notifications from the second machine never arrived. Paste here the topic from the computer where push WORKS, so both send to the same place.">Same topic on 2nd computer</button>
              <label style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#bbb;margin-top:3px;">
                <span title="On an ATTACK the laptop speaks out loud “Attention! Attack on the base!” (system synthesizer through the browser). Works as long as the game tab is alive and system sound isn't muted.">Voice alert (laptop)</span>
                <button class="mini-btn" id="ogx-voice-toggle">—</button>
              </label>
              <button class="mini-btn" id="ogx-ntfy-test" style="width:100%;margin-top:3px;" title="Sends a test notification to the ntfy topic and plays a test voice alert. If the phone doesn't vibrate within a few seconds — check the subscription in the app.">Send test notification</button>
            </div>
            <div class="status" id="ogx-moonsave-status" style="font-size:10px;margin-top:3px;">—</div>
            <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
              <div class="status" id="ogx-threatlog-status" style="font-size:10px;color:#e67e22;">Defense journal: —</div>
              <div style="display:flex;gap:4px;margin-top:3px;">
                <button class="mini-btn" id="ogx-threatlog-copy" style="flex:1;font-size:10px;" title="Copies the ENTIRE defense journal to the clipboard: every mission bar reading, every alert, every rescue and every error, with a date stamp. This is the record that shows why the fleet survived or not.">Copy attack journal</button>
                <button class="mini-btn" id="ogx-threatlog-clear" style="font-size:10px;" title="Clears the defense journal (the regular log stays untouched).">Clear</button>
              </div>
            </div>
          </div>
          <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Reads the mission bar: when “N Missions” > “M Own”, someone is flying at you. Pauses farming and expedition waves, does NOT move the fleet. Mining stays — it sends miners from the planet.</div>
        </div>

        <div class="section ${CONFIG.fleetSave?.enabled ? "active" : "inactive"}" id="ogx-fs-section">
          <div class="section-title">
            <span>Settings: Fleet Save</span>
            <button class="mini-btn" id="ogx-fs-toggle">${CONFIG.fleetSave?.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-fs-status">—</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="The fleet should be back on the base moon at this hour. A bare HH:MM means the NEAREST such clock reading — set once, works every day.">Return at (HH:MM)</span>
              <input id="ogx-fs-return" type="text" placeholder="09:00" value="${String(CONFIG.fleetSave?.returnAt || "").match(/^\d{1,2}:\d{2}$/) ? CONFIG.fleetSave.returnAt : ""}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Target moon (g:s:p). The dispatch is always FROM the base moon. A farther target = a longer flight = a longer possible FS.">Target (moon g:s:p)</span>
              <input id="ogx-fs-target" type="text" value="${CONFIG.fleetSave?.to ? `${CONFIG.fleetSave.to.galaxy}:${CONFIG.fleetSave.to.system}:${CONFIG.fleetSave.to.position}` : ""}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Flight speed in %. Slower = longer flight = longer possible FS (at 10% the flight takes 10× longer). Maximum FS = 2× the one-way flight time.">Speed (%)</span>
              <input id="ogx-fs-speed" type="number" min="1" max="100" step="1" value="${CONFIG.fleetSave?.speedPercent || 10}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <button class="mini-btn" id="ogx-fs-measure" style="width:100%;margin-top:4px;" title="Enters the dispatch form, sets the speed, reads the flight time shown by the game and LEAVES WITHOUT SENDING. From then on the planner knows the route and will compute the launch hour on its own.">Measure route (without sending)</button>
          </div>
          <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">From the base moon to another moon, Station mission, launch IMMEDIATELY (too long a window = a chain of full rounds). Ships: everything; miners stay only with mining ON. Resources from the moon minus the deuterium reserve. Failed recall = the fleet stays safe at the target.</div>
        </div>

        <div class="section ${CONFIG.expeditions.enabled ? "active" : "inactive"}" id="ogx-expo-section">
          <div class="section-title">
            <span>Settings: Expeditions</span>
            <button class="mini-btn" id="ogx-expo-toggle">${CONFIG.expeditions.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-expo-status">Idle</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Fixed launch point for EXPEDITIONS, e.g. 2:277:8 — before each wave the bot switches to this body on its own (the moon in MOON mode), and the waves fly to position 16 of ITS system and return there. Empty = waves launch from wherever you currently are.">Expedition start (g:s:p)</span>
              <input id="ogx-expo-from" type="text" placeholder="empty = where I am now" value="${CONFIG.expeditions.launchFrom ? `${CONFIG.expeditions.launchFrom.galaxy}:${CONFIG.expeditions.launchFrom.system}:${CONFIG.expeditions.launchFrom.position}` : ""}" style="width:110px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Into this many waves the combat fleet is split. You have 8 of each type → 8 waves of 1. Never more than the expedition slots.">Waves (fleet split)</span>
              <input id="ogx-expo-waves" type="number" min="1" step="1" value="${CONFIG.expeditions.waves}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Dwell time in space (“Expedition duration” on the dispatch page).">Expedition length (h)</span>
              <input id="ogx-expo-hours" type="number" min="1" max="24" step="1" value="${CONFIG.expeditions.holdingHours}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Minimum gap between waves (seconds). Gap = safety: they return one by one, so a hunter catches at most one wave.">Wave gap min (s)</span>
              <input id="ogx-expo-gapmin" type="number" min="10" step="10" value="${CONFIG.expeditions.waveGapMinSec}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Maximum gap between waves (seconds). The bot draws from the min-max range so it doesn't send every exact 120 s.">Wave gap max (s)</span>
              <input id="ogx-expo-gapmax" type="number" min="10" step="10" value="${CONFIG.expeditions.waveGapMaxSec}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="0 = Heavy Cargo splits into waves like any other ship (fleet ÷ waves) — that's the default. A value above zero forces a FIXED number of HC per wave, regardless of how many you have; it only makes sense when you need HC for farming in parallel.">Heavy Cargo / wave (0=split)</span>
              <input id="ogx-expo-hc" type="number" min="0" step="1" value="${CONFIG.expeditions.heavyCargoPerWave}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="This many fleet slots stay free for mining and manual play.">Slot reserve</span>
              <input id="ogx-expo-reserve" type="number" min="0" step="1" value="${CONFIG.expeditions.slotReserve}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Target: position 16 of the base system. Ships: everything except ${CONFIG.expeditions.excludeTypes.join(", ")}. Works together with mining.</div>
          </div>
        </div>

        <div class="section ${CONFIG.onlineBonus.enabled ? "active" : "inactive"}" id="ogx-bonus-section">
          <div class="section-title">
            <span>Settings: Bonus</span>
            <button class="mini-btn" id="ogx-bonus-toggle">${CONFIG.onlineBonus.enabled ? "ON" : "OFF"}</button>
          </div>
          <div class="status" id="ogx-bonus-status">—</div>
          <div style="font-size:9px;color:#7f8c8d;margin-top:2px;">Clicks the green “Online bonus” in the menu when it appears → antimatter + Academy points. Works together with mining/farming.</div>
        </div>

        <div class="section">
          <div class="section-title">
            <span>Anti-detection</span>
            <span class="status ${AntiDetection.isSleepTime() ? "off" : "on"}">${AntiDetection.isSleepTime() ? "SLEEP" : "ACTIVE"}</span>
          </div>
          <div class="status">Delay: ${CONFIG.antiDetection.minDelaySeconds}-${CONFIG.antiDetection.maxDelaySeconds}s | Sleep: ${CONFIG.antiDetection.sleepStartHour}:00-${CONFIG.antiDetection.sleepEndHour}:00 (local time, ±20min/day)</div>
          <div class="status" id="ogx-humanizer-status" style="font-size:10px;color:#7f8c8d;margin-top:3px;">—</div>
          <div style="margin-top:6px;border-top:1px solid #1a5276;padding-top:6px;">
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Random full-bot pauses: after 35-65min of activity, everything stops for 5-15min — mimics a human stepping away.">Coffee breaks</span>
              <button class="mini-btn" id="ogx-hum-breaks">${CONFIG.humanizer.breaks ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="10% chance of 5–15 min of idleness in the middle of work — simulates a player who stepped away from the keyboard. OFF = zero random pauses.">Random pauses (jitter)</span>
              <button class="mini-btn" id="ogx-jitter-toggle">${CONFIG.antiDetection.jitterEnabled ? "ON" : "OFF"}</button>
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Hard cap of farm attacks per UTC day. 0 = unlimited. Volume is what admins see first.">Max attacks / day (0=∞)</span>
              <input id="ogx-hum-maxatk" type="number" min="0" step="10" value="${CONFIG.humanizer.maxAttacksPerDay}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Hour when the night break starts, LOCAL time (the same as the in-game clock). Equal start and end = no break. The bounds drift ±20 min per day so the bot doesn't fall asleep to the second.">Sleep from (local hour)</span>
              <input id="ogx-hum-sleepstart" type="number" min="0" max="23" step="1" value="${CONFIG.antiDetection.sleepStartHour}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
            <label style="display:flex;justify-content:space-between;align-items:center;margin:2px 0;font-size:10px;color:#bbb;">
              <span title="Hour when the night break ends, LOCAL time.">Sleep to (local hour)</span>
              <input id="ogx-hum-sleepend" type="number" min="0" max="23" step="1" value="${CONFIG.antiDetection.sleepEndHour}" style="width:80px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
            </label>
          </div>
        </div>

        <div class="section">
          <div class="section-title">
            <span>Quick actions</span>
          </div>
          <button class="mini-btn" id="ogx-scan-now">Scan Asteroids</button>
          <button class="mini-btn" id="ogx-bonus-now" title="Check NOW whether the Online bonus button is on the page, and click it (ignores cooldown).">Claim Bonus</button>
          <button class="mini-btn" id="ogx-api-test" title="Queries the game endpoints one by one (eventbox, eventlist, galaxy, check-target, messages) and prints the HTTP status and the start of each response to the log. This determines whether fast scanning and API dispatch can work.">Test API</button>
          <button class="mini-btn" id="ogx-fleet-recon" title="Print to the log what the bot sees on the fleet page: ship types (data-ship-type), saved fleet groups, fleet and expedition slots. On the /fleet page it scans fresh; elsewhere it shows the last snapshot.">Fleet Recon</button>
          <button class="mini-btn" id="ogx-flights" title="Shows the register of your own mining flights (it sets the budget for parallel dispatches) and compares it with the mission count the game sees. Shift+click clears the register as an emergency when the budget is stuck despite an empty sky.">Flights</button>
        
          <label style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:10px;color:#bbb;" title="Google AI Studio API key (aistudio.google.com/apikey). The model reads ONLY mission reports (asteroid yield) where ordinary parsers don't understand the page format. It never makes fleet decisions. The key stays locally in Tampermonkey.">
            <span>Gemini API</span>
            <input id="ogx-llm-key" type="password" placeholder="key AIza…/AQ…" value="" style="width:130px;background:rgba(0,0,0,0.4);color:#fff;border:1px solid #1a5276;border-radius:3px;padding:2px 4px;font-size:10px;">
          </label>
          <div class="status" id="ogx-llm-status" style="font-size:9px;margin-top:2px;"></div>
        </div>


        <div id="ogx-log-pinned" class="log-pinned" style="display:none;"></div>
        <!-- v2.65.2: log collapsed to 1 line by default; click on the header
             expands the full list. The pinned alert log above manages itself
             (it shows only when it has content). -->
        <div id="ogx-log-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px; cursor:pointer;">
          <span style="font-size:11px; color:#8fa8b8;"><span id="ogx-log-chev">▸</span> Log</span>
          <div style="display:flex;gap:4px;">
            <button class="mini-btn" id="ogx-copy-logs" style="font-size:10px;">Copy</button>
            <button class="mini-btn" id="ogx-clear-logs" style="font-size:10px;">Clear</button>
          </div>
        </div>
        <div id="ogx-log-last" style="font-size:10px;font-family:monospace;color:#9fb2bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 2px;">—</div>
        <div class="log-area" id="ogx-log" style="display:none;"></div>
        <textarea id="ogx-log-textarea" style="width:100%;height:120px;font-size:9px;font-family:monospace;background:rgba(0,0,0,0.5);color:#aaa;border:1px solid #333;border-radius:4px;padding:4px;margin-top:4px;resize:vertical;display:none;box-sizing:border-box;" readonly placeholder="Click Copy to load logs..."></textarea>
      </div>
    `;

    document.body.appendChild(panel);

    // Make draggable
    makeDraggable(panel, panel.querySelector(".header"));

    // Event handlers
    document.getElementById("ogx-toggle").addEventListener("click", () => {
      // v2.69.1: disabling with visible FOREIGN fleets requires confirmation
      // — on 05.08 an attack got through with the bot accidentally disabled.
      if (CONFIG.enabled) {
        const ev = ThreatMonitor.events();
        const bar = ThreatMonitor.read();
        const foreignNow = Math.max(ev && Date.now() - ev.at < 120000 ? (ev.hostile || 0) : 0, bar ? bar.foreign : 0);
        if (foreignNow > 0 && !window.confirm(`WARNING: ${foreignNow} foreign fleets are in the air!\n\nDisabling the bot will stop AUTOMATIC DEFENSE (fleet evacuation). Detection and the journal will keep working, but nobody will move the fleet.\n\nDisable anyway?`)) return;
      }
      CONFIG.enabled = !CONFIG.enabled;
      saveConfig(CONFIG);
      const btn = document.getElementById("ogx-toggle");
      btn.textContent = CONFIG.enabled ? "ON" : "OFF";
      btn.className = `toggle-btn ${CONFIG.enabled ? "on" : "off"}`;
      if (CONFIG.enabled) {
        startScheduler();
        startDefenceLoop();
        WakeLock.acquire();
        log("Bot ENABLED", "success");
      } else {
        stopScheduler();
        // v2.69.1: the defense loop does NOT stop — it switches to observer mode
        // (detection, journal, [ATTACK DOM] dumps, push; zero fleet movement).
        WakeLock.release();
        log("Bot DISABLED — defense switches to OBSERVER MODE: it detects and alerts, but does not move the fleet.", "warn");
      }
    });

    // v2.90.0 (was either/or since v2.11.0): both modules can run at once —
    // repaint both buttons and sections after each toggle.
    const paintModuleToggles = () => {
      const aBtn = document.getElementById("ogx-asteroid-toggle");
      const aSec = document.getElementById("ogx-asteroid-section");
      if (aBtn) aBtn.textContent = CONFIG.asteroidMining.enabled ? "ON" : "OFF";
      if (aSec) aSec.className = `section ${CONFIG.asteroidMining.enabled ? "active" : "inactive"}`;
      const fBtn = document.getElementById("ogx-farm-toggle");
      const fSec = document.getElementById("ogx-farm-section");
      if (fBtn) fBtn.textContent = CONFIG.inactiveFarming.enabled ? "ON" : "OFF";
      if (fSec) fSec.className = `section ${CONFIG.inactiveFarming.enabled ? "active" : "inactive"}`;
    };

    // v2.90.0: end of either/or — both modules can be ON at once. Mining has
    // priority; farming gets only the windows when miners are in flight.
    document.getElementById("ogx-asteroid-toggle").addEventListener("click", () => {
      CONFIG.asteroidMining.enabled = !CONFIG.asteroidMining.enabled;
      saveConfig(CONFIG);
      paintModuleToggles();
      log(`Asteroid mining ${CONFIG.asteroidMining.enabled ? "enabled" : "disabled"}`, "info");
      if (CONFIG.asteroidMining.enabled && CONFIG.inactiveFarming.enabled) {
        log("Mining + farming together: asteroids have PRIORITY, farming fills the windows between miner flights.", "info");
      }
      updateStatusUI();
    });

    document.getElementById("ogx-farm-toggle").addEventListener("click", () => {
      CONFIG.inactiveFarming.enabled = !CONFIG.inactiveFarming.enabled;
      saveConfig(CONFIG);
      paintModuleToggles();
      log(`Inactive farming ${CONFIG.inactiveFarming.enabled ? "enabled" : "disabled"}`, "info");
      if (CONFIG.asteroidMining.enabled && CONFIG.inactiveFarming.enabled) {
        log("Mining + farming together: asteroids have PRIORITY, farming fills the windows between miner flights.", "info");
      }
      updateStatusUI();
    });

    // v2.15.0: incoming-fleet alarm
    {
      const tBtn = document.getElementById("ogx-threat-toggle");
      if (tBtn) tBtn.addEventListener("click", () => {
        CONFIG.threatAlarm.enabled = !CONFIG.threatAlarm.enabled;
        saveConfig(CONFIG);
        tBtn.textContent = CONFIG.threatAlarm.enabled ? "ON" : "OFF";
        if (!CONFIG.threatAlarm.enabled) {
          ThreatMonitor.clear();
          // v2.35.0: turning the alert off is an unambiguous "stop" — it also
          // disarms the rescue guard. Without this the operator had NO way to
          // manually clear a stuck state and had to wait for the fuse.
          MoonSave.disarm("alert disabled by operator");
        }
        // Ask for desktop notifications only here — never unprompted mid-scan.
        if (CONFIG.threatAlarm.enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
        log(`Foreign fleet alert ${CONFIG.threatAlarm.enabled ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
    }

    // v2.17.0: manual fleet save
    {
      const bindThreatToggle = (id, key, label) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener("click", () => {
          CONFIG.threatAlarm[key] = !CONFIG.threatAlarm[key];
          saveConfig(CONFIG);
          btn.textContent = CONFIG.threatAlarm[key] ? "ON" : "OFF";
          log(`${label} ${CONFIG.threatAlarm[key] ? "enabled" : "DISABLED"}`, CONFIG.threatAlarm[key] ? "info" : "warn");
          updateStatusUI();
        });
      };
      bindThreatToggle("ogx-auto-save", "autoSave", "Auto-save on attack");
      bindThreatToggle("ogx-auto-return", "autoReturn", "Auto-return after alert");
      bindThreatToggle("ogx-rescue-queue", "rescueQueue", "Rescue queue (2nd colony)");
      bindThreatToggle("ogx-air-save", "airSave", "Air escape (both bodies)"); // v2.85.0
      bindThreatToggle("ogx-keep-awake", "keepAwake", "Don't let the tab freeze");
      // v2.74.0: deuterium reserve (fuel for the fleet returning from expeditions)
      {
        const el = document.getElementById("ogx-deut-reserve");
        if (el) el.addEventListener("change", () => {
          const v = Math.max(0, parseInt(el.value) || 0);
          el.value = v;
          CONFIG.threatAlarm.deutReserve = v;
          saveConfig(CONFIG);
          log(`Deuterium reserve: ${v.toLocaleString()} (stays on the body on rescue/FS).`, "info");
        });
      }

      const msBtn = document.getElementById("ogx-moonsave-now");
      if (msBtn) msBtn.addEventListener("click", () => {
        const needsLearn = !MoonSave.armed();
        if (!window.confirm(
          "Move the ENTIRE fleet and ALL resources to the other body (planet ↔ moon, same coords)?\n\n" +
          "Miners will stop digging until the return." +
          (needsLearn ? "\n\nThe moon target is not known yet — the bot will first open the base galaxy, read it and finish on its own." : ""))) return;
        MoonSave.run({ manual: true, reason: "manually" }).catch(err => log(`[MOON SAVE] ${err.message}`, "error"));
      });

      const tlCopy = document.getElementById("ogx-threatlog-copy");
      if (tlCopy) tlCopy.addEventListener("click", () => {
        const text = ThreatLog.asText();
        const n = ThreatLog.all().length;
        // GM_setClipboard is not in this script's @grant, so we go the same
        // route as the existing Copy button: navigator.clipboard, and when the
        // browser refuses — textarea + execCommand. Attack evidence must not
        // depend on a single API.
        const done = () => { tlCopy.textContent = "Copied!"; setTimeout(() => { tlCopy.textContent = "Copy attack journal"; }, 1500); log(`Defense journal copied (${n} entries).`, "success"); };
        const fallback = () => {
          try {
            const ta = document.createElement("textarea");
            ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
            document.body.appendChild(ta); ta.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(ta);
            if (ok) return done();
          } catch {}
          log(`Clipboard unavailable — printing the defense journal (${n} entries):`, "warn");
          text.split("\n").slice(0, 150).forEach(l => log(l, "info"));
        };
        try {
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
          else fallback();
        } catch { fallback(); }
      });
      const tlClear = document.getElementById("ogx-threatlog-clear");
      if (tlClear) tlClear.addEventListener("click", () => {
        if (!window.confirm("Clear the defense journal? You'll lose the record of what the bot saw during the alerts so far.")) return;
        ThreatLog.clear();
        log("Defense journal cleared.", "info");
        updateStatusUI();
      });

      // v2.67.0: full dress rehearsal of the defense automaton — see the button tooltip.
      const simBtn = document.getElementById("ogx-threat-sim");
      if (simBtn) simBtn.addEventListener("click", () => {
        if (!CONFIG.enabled || !CONFIG.threatAlarm?.enabled) { log("[TEST] enable the bot and the foreign fleet alert first.", "error"); return; }
        if (!window.confirm(
          "ATTACK SIMULATION on the base?\n\n" +
          "For 90 s the defense will see 1 hostile attack and go through the FULL path for real:\n" +
          "• confirmation ~25-35 s,\n" +
          "• EVACUATION of the entire fleet and resources to the other body (planet ↔ moon),\n" +
          "• after ~2 min the alert fades and the fleet returns automatically.\n\n" +
          "Cost: a few minutes of mining and two short flights. Continue?")) return;
        GM_setValue("ogamex_threat_sim_until", String(Date.now() + 90 * 1000));
        log("[TEST] ATTACK SIMULATION started (90 s). Watch the sequence: candidate → ALERT → RESCUE → end of alert → RETURN. Everything below is the real defense machinery.", "error");
        ThreatLog.add("reading", "TEST: attack simulation started by the operator (90 s).");
      });

      // v2.87.0: blind bar simulation — E2E of the path that failed at 13:10.
      const simBlindBtn = document.getElementById("ogx-threat-sim-blind");
      if (simBlindBtn) simBlindBtn.addEventListener("click", () => {
        if (!window.confirm(
          "BLIND BAR SIMULATION (attack scenario from 13:10)?\n\n" +
          "The movement list and server events stay CLEAN — only the mission bar gets a synthetic +1 foreign fleet, exactly like attacks from your own system.\n" +
          "Expected sequence:\n" +
          "• BAR: 1 foreign, list only 0 — I treat it as an ATTACK,\n" +
          "• candidate → confirmation ~25-35 s,\n" +
          "• RESCUE to the FLEET'S HOME (colony switch + planet↔moon jump),\n" +
          "• after ~2 min the alert fades and the fleet returns.\n\n" +
          "WARNING: for the 90 s of the simulation the real bar reading is swapped out — don't run it during a real arrival. Continue?")) return;
        GM_setValue("ogamex_threat_sim_blind_until", String(Date.now() + 90 * 1000));
        log("[TEST] BLIND BAR SIMULATION started (90 s) — this is exactly the path that failed on 12.08 at 13:10. Watch: BAR>list → candidate → ALERT → RESCUE to the fleet's home → RETURN.", "error");
        ThreatLog.add("reading", "TEST: blind bar simulation started by the operator (90 s).");
      });

      const mbBtn = document.getElementById("ogx-moonback-now");
      if (mbBtn) mbBtn.addEventListener("click", () => {
        const noGuard = !MoonSave.watch().armed;
        if (!window.confirm("Pull back the ENTIRE fleet and ALL resources to the base body?" +
          (noGuard ? "\n\n(Guard is not active — if there is nothing on the moon, the form simply won't send anything.)" : ""))) return;
        MoonSave.returnHome({ byOperator: true }).catch(err => log(`[MOON SAVE] ${err.message}`, "error"));
      });
    }

    // v2.14.0: expedition controls
    {
      const eBtn = document.getElementById("ogx-expo-toggle");
      if (eBtn) eBtn.addEventListener("click", () => {
        CONFIG.expeditions.enabled = !CONFIG.expeditions.enabled;
        saveConfig(CONFIG);
        eBtn.textContent = CONFIG.expeditions.enabled ? "ON" : "OFF";
        const sec = document.getElementById("ogx-expo-section");
        if (sec) sec.className = `section ${CONFIG.expeditions.enabled ? "active" : "inactive"}`;
        if (CONFIG.expeditions.enabled && !FleetRecon.expeditionLink()) {
          log("Expeditions enabled — open any Galaxy page once so the bot can read the Expedition link (row 16).", "warn");
        }
        log(`Expeditions ${CONFIG.expeditions.enabled ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
      const bindExpo = (id, key, label, { min = 0 } = {}) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          const v = Math.max(min, parseInt(el.value) || 0);
          el.value = v;
          CONFIG.expeditions[key] = v;
          // Keep the gap range coherent — a max below min would make the
          // randomised spacing collapse to a constant.
          if (key === "waveGapMinSec" && CONFIG.expeditions.waveGapMaxSec < v) {
            CONFIG.expeditions.waveGapMaxSec = v;
            const mx = document.getElementById("ogx-expo-gapmax");
            if (mx) mx.value = v;
          }
          if (key === "waveGapMaxSec" && v < CONFIG.expeditions.waveGapMinSec) {
            CONFIG.expeditions.waveGapMinSec = v;
            const mn = document.getElementById("ogx-expo-gapmin");
            if (mn) mn.value = v;
          }
          saveConfig(CONFIG);
          log(`${label} set to ${v}`, "info");
          updateStatusUI();
        });
      };
      bindExpo("ogx-expo-waves", "waves", "Expedition waves", { min: 1 });
      bindExpo("ogx-expo-hours", "holdingHours", "Expedition duration (h)", { min: 1 });
      bindExpo("ogx-expo-gapmin", "waveGapMinSec", "Wave gap min (s)", { min: 10 });
      bindExpo("ogx-expo-gapmax", "waveGapMaxSec", "Wave gap max (s)", { min: 10 });
      bindExpo("ogx-expo-hc", "heavyCargoPerWave", "Heavy Cargo per wave", { min: 0 });
      bindExpo("ogx-expo-reserve", "slotReserve", "Expedition slot reserve", { min: 0 });
    }

    // v2.60.0: Fleet Save controls
    {
      const fsBtn = document.getElementById("ogx-fs-toggle");
      if (fsBtn) fsBtn.addEventListener("click", () => {
        // ── v2.68.3: enabling FS requires confirmation WITH A PLAN ──
        // Incident 05.08 09:32: an accidentally enabled toggle + a saved hour
        // and a measured route = a fully automatic launch of the ENTIRE fleet two
        // minutes later. FS is meant to start on its own at night — so the only
        // proper place for a human is the moment of enabling, with a clear
        // announcement of WHEN the launch will happen. Disabling stays without questions (it must be quick).
        if (!CONFIG.fleetSave.enabled) {
          const p = FleetSave.plan(Date.now(), { ignoreEnabled: true });
          const f = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
          const kiedy = p.ok
            ? `The window fits RIGHT NOW — the launch will happen within ~1 min:\n  launch ${f(p.launchAt)} → recall ${f(p.recallAt)} → return ${f(p.returnAt)}.`
            : p.launchDueAt
              ? `Next automatic launch: approx. ${f(p.launchDueAt)}.`
              : `Launch paused: ${p.why}`;
          if (!window.confirm(`Enable Fleet Save?\n\n${kiedy}\n\nThe bot will send the ENTIRE fleet (except miners) + resources from the moon, without further questions.`)) return;
        }
        CONFIG.fleetSave.enabled = !CONFIG.fleetSave.enabled;
        saveConfig(CONFIG);
        fsBtn.textContent = CONFIG.fleetSave.enabled ? "ON" : "OFF";
        const sec = document.getElementById("ogx-fs-section");
        if (sec) sec.className = `section ${CONFIG.fleetSave.enabled ? "active" : "inactive"}`;
        if (CONFIG.fleetSave.enabled && !FleetSave.flightMs()) {
          log("[FS] enabled, but the route is unmeasured — click \"Measure route (no dispatch)\" so the planner learns the flight time.", "warn");
        }
        log(`Fleet Save ${CONFIG.fleetSave.enabled ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
      const fsReturn = document.getElementById("ogx-fs-return");
      if (fsReturn) fsReturn.addEventListener("change", () => {
        const v = fsReturn.value.trim();
        if (v && !/^\d{1,2}:\d{2}$/.test(v)) { log(`[FS] "${v}" is not a time — give HH:MM, e.g. 09:00.`, "error"); return; }
        CONFIG.fleetSave.returnAt = v || null;
        saveConfig(CONFIG);
        log(v ? `[FS] return set to the nearest ${v}.` : "[FS] return time cleared.", "info");
        updateStatusUI();
      });
      const fsTarget = document.getElementById("ogx-fs-target");
      if (fsTarget) fsTarget.addEventListener("change", () => {
        const m = fsTarget.value.trim().match(/^(\d+):(\d+):(\d+)$/);
        if (!m) { log(`[FS] "${fsTarget.value}" is not coordinates — give g:s:p, e.g. 3:269:5.`, "error"); return; }
        CONFIG.fleetSave.to = { galaxy: +m[1], system: +m[2], position: +m[3] };
        saveConfig(CONFIG);
        log(`[FS] target: moon [${m[1]}:${m[2]}:${m[3]}]. The route must be measured again (different distance = different flight time).`, "info");
        updateStatusUI();
      });
      const fsSpeed = document.getElementById("ogx-fs-speed");
      if (fsSpeed) fsSpeed.addEventListener("change", () => {
        const v = Math.max(1, Math.min(100, parseInt(fsSpeed.value) || 10)); // v2.74.1: 3%/5% allowed (longer flight = longer FS)
        fsSpeed.value = v;
        CONFIG.fleetSave.speedPercent = v;
        saveConfig(CONFIG);
        log(`[FS] speed ${v}%. The route must be measured again (different speed = different flight time).`, "info");
        updateStatusUI();
      });
      const fsMeasure = document.getElementById("ogx-fs-measure");
      if (fsMeasure) fsMeasure.addEventListener("click", () => {
        if (!window.confirm("Measure the FS route? The bot will enter the dispatch form, set the speed, read the flight time and EXIT WITHOUT DISPATCHING. No fleet will fly.")) return;
        GM_setValue("ogamex_fs_measure_at", String(Date.now()));
        FleetSave.launch({ measure: true });
        // v2.62.1: don't wait for the scheduler tick (50-90 s) — the click must work
        // immediately. When this tab is not the leader, handlePendingMission will
        // itself say "PAUSED — another tab is running the bot", which is also an answer.
        setTimeout(() => { handlePendingMission().catch(() => {}); }, 1200);
      });
    }

    // v2.13.0: online-bonus toggle (independent of mining/farming)
    {
      const bnBtn = document.getElementById("ogx-bonus-toggle");
      if (bnBtn) bnBtn.addEventListener("click", () => {
        CONFIG.onlineBonus.enabled = !CONFIG.onlineBonus.enabled;
        saveConfig(CONFIG);
        bnBtn.textContent = CONFIG.onlineBonus.enabled ? "ON" : "OFF";
        const sec = document.getElementById("ogx-bonus-section");
        if (sec) sec.className = `section ${CONFIG.onlineBonus.enabled ? "active" : "inactive"}`;
        log(`Online bonus auto-claim ${CONFIG.onlineBonus.enabled ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
      const apiTestBtn = document.getElementById("ogx-api-test");
      if (apiTestBtn) apiTestBtn.addEventListener("click", async () => {
        apiTestBtn.disabled = true;
        log("[API TEST] checking the game's endpoints…", "info");
        ApiSniffer.dump();
        Ajax.resetDead(); // a manual test always opens the gates
        GM_setValue("ogamex_yield_fetch_at", "0"); // and removes the 30-minute report throttle
        try { await Ajax.diagnose(); } catch (e) { log(`[API TEST] error: ${e.message}`, "error"); }
        finally { apiTestBtn.disabled = false; }
      });
      // v2.67.0: ntfy notifications — topic, toggle, test
      {
        const nBtn = document.getElementById("ogx-ntfy-toggle");
        const nTopic = document.getElementById("ogx-ntfy-topic");
        const nSet = document.getElementById("ogx-ntfy-topic-set");
        if (nSet) nSet.addEventListener("click", () => {
          // ── v2.77.0: one topic for all machines ──
          // The topic was randomised per computer and per browser (GM storage does
          // not sync between machines), so the work laptop wrote to a
          // topic the phone doesn't subscribe to — the push "worked" and went
          // into the void. Symptom: notifications at home, none at work.
          const cur = Notifier.topic();
          const v = prompt(
            "ntfy topic for THIS computer.\n\n" +
            "Paste the topic from the computer where notifications WORK — then both\n" +
            "send to the same place and the phone gets everything from both machines.\n" +
            "The topic works like a password: don't share it with anyone.",
            cur);
          if (v === null) return;
          const t = String(v).trim().replace(/^https?:\/\/ntfy\.sh\//i, "").replace(/\/+$/, "");
          if (!/^[A-Za-z0-9_-]{4,64}$/.test(t)) {
            alert("The topic can have 4-64 characters: letters, digits, hyphen, underscore.");
            return;
          }
          GM_setValue(Notifier.KEY_TOPIC, t);
          log(`[PUSH] ntfy topic of this computer set to: ${t}`, "success");
          if (nTopic) nTopic.textContent = `topic: ${t}`;
          // v2.77.1: don't lie that it was sent when push is off (07.08:
          // the owner saw "I sent a test notification" with the toggle OFF).
          if (Notifier.enabled()) {
            Notifier.push("🔔 This computer connected", `Notifications from this machine now go to topic ${t}.`, "default", "bell");
          }
          alert(Notifier.enabled()
            ? `Set: ${t}\n\nI sent a test notification — check your phone.`
            : `Set: ${t}\n\nWARNING: the \"Push to phone (ntfy)\" toggle is OFF, so NOTHING was sent — attack alerts won't go out either. Turn it on in the panel.`);
        });
        const nTest = document.getElementById("ogx-ntfy-test");
        const paint = () => {
          if (nBtn) nBtn.textContent = Notifier.enabled() ? "ON" : "OFF";
          if (nTopic) nTopic.textContent = `topic: ${Notifier.topic()}`;
          if (nTopic) nTopic.style.color = Notifier.enabled() ? "#27ae60" : "#7f8c8d";
        };
        if (nBtn) nBtn.addEventListener("click", () => {
          GM_setValue(Notifier.KEY_ON, Notifier.enabled() ? "0" : "1");
          log(`Push to phone: ${Notifier.enabled() ? "ENABLED" : "disabled"}.`, "info");
          paint();
        });
        if (nTopic) nTopic.addEventListener("click", () => {
          try { navigator.clipboard.writeText(Notifier.topic()); nTopic.textContent = "copied ✓"; setTimeout(paint, 1200); } catch {}
        });
        if (nTest) nTest.addEventListener("click", () => {
          Notifier.push("🔔 OGameX notification test", `It works! Topic: ${Notifier.topic()}. The bot will send attack, evacuation and defense-error alerts here.`, "default", "bell");
          Notifier.siren(3);
          Notifier.speak("Voice alarm test. This is what an attack on the base will sound like.", 1);
          log(`[PUSH] test notification sent to topic ${Notifier.topic()} — the phone should vibrate within a few seconds.`, "success");
        });
        const vBtn = document.getElementById("ogx-voice-toggle");
        if (vBtn) {
          const paintV = () => { vBtn.textContent = Notifier.voiceEnabled() ? "ON" : "OFF"; };
          vBtn.addEventListener("click", () => {
            GM_setValue(Notifier.KEY_VOICE, Notifier.voiceEnabled() ? "0" : "1");
            log(`Voice alarm: ${Notifier.voiceEnabled() ? "ENABLED" : "disabled"}.`, "info");
            if (Notifier.voiceEnabled()) Notifier.speak("Voice alarm enabled.", 1);
            paintV();
          });
          paintV();
        }
        paint();
      }
      const recon = document.getElementById("ogx-fleet-recon");
      if (recon) recon.addEventListener("click", () => {
        // On the fleet page take a fresh reading; elsewhere show what the last
        // visit stored (the data only exists on step 1 of /fleet).
        const snap = GameState.getCurrentPage() === "fleet" ? FleetRecon.scan() : FleetRecon.snapshot();
        FleetRecon.logSummary(snap, GameState.getCurrentPage() === "fleet" ? "live" : "cached");
        // v2.16.2: same button also captures what Stage 2 (fleet-save to the
        // moon) needs: the events table shape and the base row's moon link.
        ThreatMonitor.dumpMarkupOnce(true).catch(() => {});
        ThreatMonitor.fetchBaseRowOnce().catch(() => {});
        const exp = FleetRecon.learnExpeditionLink() || FleetRecon.expeditionLink();
        log(exp ? `[EXPO] link: ${exp.href} (mission=${exp.mission ?? "?"})`
                : "[EXPO] link unknown — open any Galaxy page once so row 16 can be read.", exp ? "info" : "warn");
      });

      // v2.58.0: preview/emergency reset of the mining-flight register. The register
      // sets the budget of parallel dispatches, so when a ghost is stuck in it — mining stalls.
      const flightsBtn = document.getElementById("ogx-flights");
      if (flightsBtn) flightsBtn.addEventListener("click", (ev) => {
        const mm = document.body.textContent.match(/(\d+)\s*Missions?:\s*(\d+)\s*Own/);
        const own = mm ? parseInt(mm[2]) : -1;
        if (ev.shiftKey) {
          MiningFlights.clear();
          GM_setValue("ogamex_fleet_return_at", "0");
          log("Flight register cleared manually (Shift) — budget free, scan resumed.", "asteroid");
          return;
        }
        const list = MiningFlights.list();
        log(`Flight register: ${list.length} entr(y/ies); the game sees ${own < 0 ? "?" : own} own missions.`, "asteroid");
        const now = Date.now();
        list.forEach(e => log(`  - ${e.coord} — return in ${Math.ceil((e.returnAt - now) / 60000)} min`, "asteroid"));
        if (list.length === 0) log("  (empty — the budget doesn't block dispatches)", "asteroid");
        log("Shift+click = emergency register clear.", "asteroid");
      });
      const stBtn = document.getElementById("ogx-selftest");
      if (stBtn) stBtn.addEventListener("click", () => {
        log("[AUTOTEST] starting a defense check on this bot version…", "info");
        DefenceSelfTest.run({ manual: true });
      });
      const bnNow = document.getElementById("ogx-bonus-now");
      if (bnNow) bnNow.addEventListener("click", () => {
        log("Manual online-bonus check...", "info");
        GM_setValue(OnlineBonus.KEY_MARKUP, ""); // re-dump the markup on a manual probe
        OnlineBonus.run({ manual: true }).catch(err => log(`Online bonus error: ${err.message}`, "error"));
      });
    }

    // Farming config inputs (numeric + the free-text ranges field)
    const bindFarmNum = (id, key, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", () => {
        const v = Math.max(0, parseInt(el.value) || 0);
        el.value = v;
        CONFIG.inactiveFarming[key] = v;
        saveConfig(CONFIG);
        log(`${label} set to ${v.toLocaleString()}`, "info");
        updateStatusUI();
      });
    };
    bindFarmNum("ogx-farm-hc", "hcPerFlight", "Ships / attack");
    bindFarmNum("ogx-farm-cooldown", "targetCooldownMin", "Target cooldown");
    bindFarmNum("ogx-farm-reserve", "slotReserve", "Slot reserve");
    bindFarmNum("ogx-farm-maxrank", "maxTargetRank", "Max target rank (0 = no filter)");
    bindFarmNum("ogx-farm-refresh", "dbRefreshHours", "Full base scan every (h)");
    // v2.89.0: target-base preview — coordinates + player + rank, sorted by rank.
    {
      const el = document.getElementById("ogx-farm-dbdump");
      if (el) el.addEventListener("click", () => {
        openLogPanel();
        const db = FarmTargetDB.load();
        const rows = Object.entries(db)
          .map(([coord, e]) => ({ coord, ...e }))
          .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
        if (!rows.length) { log("Target base EMPTY — wait for the full range scan.", "warn"); return; }
        const maxRank = CONFIG.inactiveFarming.maxTargetRank || 0;
        log(`── TARGET BASE: ${rows.length} inactive${maxRank ? `, rank limit ≤ ${maxRank}` : ""} ──`, "info");
        rows.forEach(r => {
          const age = Math.round((Date.now() - (r.seenAt || 0)) / 3600000);
          const inLimit = farmRankEligible(r.rank, maxRank) ? "✓" : "✗";
          log(`${inLimit} [${r.coord}] ${r.name} — rank ${r.rank ?? "?"} (seen ${age}h ago)`, "info");
        });
      });
    }
    // v2.97.0: loot-priority preview
    {
      const el = document.getElementById("ogx-farm-topdump");
      if (el) el.addEventListener("click", () => {
        openLogPanel();
        const rows = FarmYieldDB.top(15);
        if (!rows.length) { log("Loot base EMPTY — visit a player profile once (Plunder Journal) or wait for the fetch (15 min).", "warn"); return; }
        const med = FarmYieldDB.median();
        const floor = CONFIG.inactiveFarming.minTargetProfit || 0;
        log(`── TOP TARGETS by loot (median ${med?.toLocaleString("en-GB") ?? "?"}${floor ? `, threshold ${floor.toLocaleString("en-GB")}` : ", threshold OFF"}) ──`, "info");
        rows.forEach((r, i) => log(`${i + 1}. [${r.coord}] ${r.player} — average loot ${r.p.toLocaleString("en-GB")} (samples: ${r.n})`, "info"));
      });
    }
    {
      const el = document.getElementById("ogx-farm-repeat");
      if (el) el.addEventListener("click", () => {
        CONFIG.inactiveFarming.repeatEachSweep = CONFIG.inactiveFarming.repeatEachSweep === false;
        el.textContent = CONFIG.inactiveFarming.repeatEachSweep ? "ON" : "OFF";
        saveConfig(CONFIG);
        log(`Restart the sweep from scratch: ${CONFIG.inactiveFarming.repeatEachSweep ? "ENABLED — every sweep attacks everyone from scratch" : "disabled — Target cooldown applies"}.`, "info");
        updateStatusUI();
      });
    }
    // v2.98.0: sequential mode vs loot priority. Switching clears the sweep
    // state — the old queue (by loot or sorted) doesn't finish in the
    // new mode.
    {
      const el = document.getElementById("ogx-farm-seq");
      if (el) el.addEventListener("click", () => {
        CONFIG.inactiveFarming.sequentialSweep = CONFIG.inactiveFarming.sequentialSweep !== true;
        el.textContent = CONFIG.inactiveFarming.sequentialSweep ? "ON" : "OFF";
        saveConfig(CONFIG);
        FarmState.clear();
        log(`Farming mode: ${CONFIG.inactiveFarming.sequentialSweep ? "SEQUENTIAL — every sweep sweeps the whole range in order (1→end), targets in order of encounter" : "LOOT PRIORITY — rounds over known systems, fattest targets first"}. Current sweep restarted.`, "info");
        updateStatusUI();
      });
    }
    // v2.72.0: farm ship selection (dropdown — values are live data-ship-type)
    {
      const el = document.getElementById("ogx-farm-ship");
      if (el) el.addEventListener("change", () => {
        CONFIG.inactiveFarming.shipType = el.value;
        saveConfig(CONFIG);
        log(`Farm ship type set to ${el.value}`, "info");
      });
    }
    // v2.12.0: humanizer controls
    {
      const bBtn = document.getElementById("ogx-hum-breaks");
      if (bBtn) bBtn.addEventListener("click", () => {
        CONFIG.humanizer.breaks = !CONFIG.humanizer.breaks;
        saveConfig(CONFIG);
        bBtn.textContent = CONFIG.humanizer.breaks ? "ON" : "OFF";
        if (!CONFIG.humanizer.breaks) GM_setValue("ogamex_break_until", "0"); // end an active break
        log(`Coffee breaks ${CONFIG.humanizer.breaks ? "enabled" : "disabled"}`, "info");
        updateStatusUI();
      });
      const jitBtn = document.getElementById("ogx-jitter-toggle");
      if (jitBtn) jitBtn.addEventListener("click", () => {
        CONFIG.antiDetection.jitterEnabled = !CONFIG.antiDetection.jitterEnabled;
        saveConfig(CONFIG);
        jitBtn.textContent = CONFIG.antiDetection.jitterEnabled ? "ON" : "OFF";
        log(`Random pauses (jitter): ${CONFIG.antiDetection.jitterEnabled ? "enabled" : "DISABLED"}.`, "info");
      });
      const mAtk = document.getElementById("ogx-hum-maxatk");
      if (mAtk) mAtk.addEventListener("change", () => {
        const v = Math.max(0, parseInt(mAtk.value) || 0);
        mAtk.value = v;
        CONFIG.humanizer.maxAttacksPerDay = v;
        saveConfig(CONFIG);
        log(`Max attacks/day set to ${v === 0 ? "unlimited" : v}`, "info");
        updateStatusUI();
      });
      const bindSleep = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          const v = Math.min(23, Math.max(0, parseInt(el.value) || 0));
          el.value = v;
          CONFIG.antiDetection[key] = v;
          saveConfig(CONFIG);
          log(`Sleep window: ${CONFIG.antiDetection.sleepStartHour}:00-${CONFIG.antiDetection.sleepEndHour}:00 local time${CONFIG.antiDetection.sleepStartHour === CONFIG.antiDetection.sleepEndHour ? " (disabled)" : ""}`, "info");
        });
      };
      bindSleep("ogx-hum-sleepstart", "sleepStartHour");
      bindSleep("ogx-hum-sleepend", "sleepEndHour");
    }

    {
      const el = document.getElementById("ogx-farm-ranges");
      if (el) el.addEventListener("change", () => {
        CONFIG.inactiveFarming.ranges = el.value.trim();
        saveConfig(CONFIG);
        const parsed = InactiveFarmer.parseRanges(CONFIG.inactiveFarming.ranges);
        log(`Farm ranges set: "${CONFIG.inactiveFarming.ranges}" → ${parsed.length} valid range(s), ${parsed.reduce((a, r) => a + r.end - r.start + 1, 0)} systems`, parsed.length ? "info" : "warn");
        FarmState.clear(); // ranges changed → restart sweep from scratch
        GM_setValue("ogamex_farm_cooldown_until", "0");
        // v2.89.0: new ranges = the base may not cover the terrain → the next
        // pass MUST be a full scan (base sweeps filter by ranges anyway,
        // but without this the bot would keep circling the old slice).
        GM_setValue("ogamex_farm_last_full_sweep", "0");
        updateStatusUI();
      });
    }

    // ── v2.10.2: live right-sizing config inputs ──
    const bindCfgInput = (id, key, label) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", () => {
        const v = Math.max(0, parseInt(el.value) || 0);
        el.value = v;
        CONFIG.asteroidMining[key] = v;
        saveConfig(CONFIG);
        log(`${label} set to ${v === 0 ? "auto/all" : v.toLocaleString()}`, "info");
        updateStatusUI();
      });
    };
    // ── v2.84.0: fixed launch points (miners / expeditions) ──
    // Entering "g:s:p" → the module launches from there (the bot switches bodies itself);
    // empty → from the active body. Coordinates outside the planet list are accepted
    // WITH A WARNING (the bar may not be reloaded), but we say it out loud.
    {
      const bindLaunchFrom = (id, getCfg, setCfg, label) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          const raw = (el.value || "").trim();
          if (!raw) {
            setCfg(null);
            saveConfig(CONFIG);
            log(`${label}: launch point cleared — launching from the active body.`, "info");
            updateStatusUI();
            return;
          }
          const m = raw.match(/^(\d+)\s*:\s*(\d+)\s*:\s*(\d+)$/);
          if (!m) {
            const cur = getCfg();
            el.value = cur ? `${cur.galaxy}:${cur.system}:${cur.position}` : "";
            log(`${label}: "${raw}" is not g:s:p coordinates — no change.`, "error");
            return;
          }
          const c = { galaxy: +m[1], system: +m[2], position: +m[3] };
          setCfg(c);
          saveConfig(CONFIG);
          const known = !!HomeBase.pairAnchor(c) || ThreatMonitor.ownBodies().has(`${c.galaxy}:${c.system}:${c.position}`);
          log(`${label}: launch set to [${c.galaxy}:${c.system}:${c.position}]${CONFIG.baseBody === "moon" ? " (moon)" : ""}.${known ? "" : " WARNING: I don't see these coordinates on the planet list — check the entry."}`, known ? "success" : "warn");
          updateStatusUI();
        });
      };
      bindLaunchFrom("ogx-cfg-mining-from",
        () => CONFIG.asteroidMining.launchFrom,
        (v) => { CONFIG.asteroidMining.launchFrom = v; },
        "[START MINERS]");
      bindLaunchFrom("ogx-expo-from",
        () => CONFIG.expeditions.launchFrom,
        (v) => { CONFIG.expeditions.launchFrom = v; },
        "[START EXPEDITIONS]");
      bindLaunchFrom("ogx-farm-from",
        () => CONFIG.inactiveFarming.launchFrom,
        (v) => { CONFIG.inactiveFarming.launchFrom = v; },
        "[START FARMING]");
      {
        const el = document.getElementById("ogx-farm-minprofit");
        if (el) el.addEventListener("change", () => {
          CONFIG.inactiveFarming.minTargetProfit = Math.max(0, parseInt(el.value) || 0);
          saveConfig(CONFIG);
          log(`Target loot threshold: ${CONFIG.inactiveFarming.minTargetProfit ? CONFIG.inactiveFarming.minTargetProfit.toLocaleString("en-GB") : "OFF (0)"}.`, "info");
        });
      }
    }
    // v2.83.0: FERRY toggle (OFF by default — the bot doesn't move fleets on its own)
    {
      const ferryBtn = document.getElementById("ogx-ferry-toggle");
      if (ferryBtn) ferryBtn.addEventListener("click", () => {
        const on = !(CONFIG.moonFerry?.enabled);
        if (on && !window.confirm("Enable the FERRY?\n\nEvery 2 h the bot will automatically move EVERYTHING from the active planet to its moon (fleet, resources, deuterium minus reserve). The first trip may start right away.")) return;
        CONFIG.moonFerry = { ...(CONFIG.moonFerry || {}), enabled: on };
        saveConfig(CONFIG);
        ferryBtn.textContent = on ? "ON" : "OFF";
        log(on ? "[FERRY] enabled — every 2 h everything from the active planet goes to its moon." : "[FERRY] disabled — the bot doesn't move fleets on its own; moving only manually (RESCUE / Deploy).", "info");
      });
    }
    // v2.69.0: moon-mode toggle (applies to mining+expeditions+debris)
    {
      const bbBtn = document.getElementById("ogx-base-body");
      if (bbBtn) bbBtn.addEventListener("click", () => {
        const toMoon = CONFIG.baseBody !== "moon";
        if (toMoon && !window.confirm("Launch dispatches from the MOON?\n\nPhalanx can't see flights from the moon — no more sniping the fleet on its way back. Since v2.82.0 this means the moon of the CURRENT system (where you are). CONDITION: fleet, miners, recyclers and deuterium must be on that moon (move them with the RESCUE FLEET button if they are on the planet). A system without a moon = launch from the planet.")) return;
        CONFIG.baseBody = toMoon ? "moon" : "planet";
        saveConfig(CONFIG);
        bbBtn.textContent = toMoon ? "MOON" : "PLANET";
        log(`Routine dispatch start: ${toMoon ? "MOON (phalanx blind)" : "PLANET (note: phalanx sees flights!)"}`, toMoon ? "success" : "warn");
      });
    }
    bindCfgInput("ogx-cfg-miners", "minersPerMission", "Miners per flight");
    bindCfgInput("ogx-cfg-total", "totalMinersToUse", "Total miners to use");
    bindCfgInput("ogx-cfg-cargo", "cargoPerMiner", "Cargo/miner");
    bindCfgInput("ogx-cfg-est", "expectedResourcesPerAsteroid", "Est. asteroid resources");

    document.getElementById("ogx-scan-now").addEventListener("click", async () => {
      log("Manual scan triggered...", "asteroid");
      // v2.27.0: the operator asking for a scan outranks any cooldown. Without
      // this the button could find ranges and the very next scheduler tick
      // would still refuse to sweep them, because the cooldown from the last
      // empty fetch was never cleared — exactly what happened at 22:53.
      GM_setValue("ogamex_scan_cooldown_until", "0");
      GM_setValue("ogamex_hint_probe_at", "0");
      // If already on galaxy page, check current position 17 first
      if (GameState.getCurrentPage() === "galaxy") {
        const result = AsteroidScanner.checkCurrentPageForAsteroid();
        if (result.found) {
          log(`Asteroid detected! ${result.fleetUrl ? "Fleet URL: " + result.fleetUrl : ""}`, "success");
          updateStatusUI();
          // Dispatch fleet to the found asteroid
          if (result.fleetUrl) {
            const url = window.location.href;
            const gMatch = url.match(/[?&]x=(\d+)/);
            const sMatch = url.match(/[?&]y=(\d+)/);
            const galaxy = gMatch ? parseInt(gMatch[1]) : 0;
            const system = sMatch ? parseInt(sMatch[1]) : 0;

            // v2.9.3: TTL vs flight check (same guard as auto-dispatch).
            const baseForCheck = HomeBase.mining();
            if (result.ttlSeconds != null && baseForCheck) {
              const sameGal = baseForCheck.galaxy === galaxy;
              const dist = sameGal ? Math.abs(baseForCheck.system - system) : Infinity;
              const estMin = sameGal ? AsteroidScanner.estimateFlightMinutes(dist) : Infinity;
              const estSec = estMin * 60;
              if (!Number.isFinite(estSec) || estSec + 300 > result.ttlSeconds) {
                log(`SKIP manual dispatch — flight ~${estMin}min (${estSec}s) + 300s buffer > TTL ${result.ttlSeconds}s`, "warn");
                // v2.9.6: skip-via-TTL does NOT add to DispatchedAsteroids.
                return;
              }
            }
            // v2.10.24: manual path never checked the dedup store — a manual
            // "Scan Asteroids" click while a fleet was already flying to these
            // coords sent a duplicate.
            if (DispatchedAsteroids.has(galaxy, system)) {
              log(`Asteroid [${galaxy}:${system}:17] already dispatched — not sending again (manual)`, "warn");
              return;
            }
            log(`Dispatching fleet via: ${result.fleetUrl}`, "asteroid");
            DispatchedAsteroids.add(galaxy, system);
            GM_setValue("pending_mission", JSON.stringify({
              type: "asteroid_mining_direct",
              fleetUrl: result.fleetUrl,
              shipType: "ASTEROID_MINER",
              quantity: AsteroidYieldTracker.minersNeeded(), // right-sized (0 = all, until learned)
              launchAt: HomeBase.mining(), // v2.84.0: where the fleet should leave from
              step: "select_ships_direct",
              resumeScan: false,
              timestamp: Date.now(),
            }));
            RateLimiter.record();
            await AntiDetection.shortDelay();
            window.location.replace(result.fleetUrl);
          }
          return;
        }
      }
      // Start full range scan → navigate through systems
      await AsteroidMiner.startNewScan();
    });

    document.getElementById("ogx-minimize").addEventListener("click", () => {
      const body = document.getElementById("ogx-body");
      body.style.display = body.style.display === "none" ? "block" : "none";
    });

    // v2.64.0: Gemini key — saved on every change, the status shows the state
    {
      const llmKey = document.getElementById("ogx-llm-key");
      const llmStatus = document.getElementById("ogx-llm-status");
      const paintLlm = () => {
        if (!llmStatus) return;
        const k = LlmParser.apiKey();
        llmStatus.textContent = k
          ? `LLM active (key …${k.slice(-6)}, uses today: ${LlmParser._usedToday()}/${LlmParser.DAILY_LIMIT})`
          : "LLM disabled — paste a key from aistudio.google.com/apikey";
        llmStatus.style.color = k ? "#27ae60" : "#7f8c8d";
      };
      if (llmKey) {
        // We don't put the key into value in the HTML (it would end up in DOM dumps in the log);
        // the field only shows WHETHER the key is present.
        if (LlmParser.apiKey()) llmKey.placeholder = "key saved ✓";
        llmKey.addEventListener("change", () => {
          const v = llmKey.value.trim();
          if (!v) return;
          GM_setValue(LlmParser.KEY_API, v);
          llmKey.value = "";
          llmKey.placeholder = "key saved ✓";
          log("[LLM] Gemini key saved locally. The model will read yield reports where ordinary parsers don't understand the page.", "success");
          paintLlm();
        });
      }
      paintLlm();
    }
    // v2.65.2: clicking the log header expands/collapses the full list
    {
      const lh = document.getElementById("ogx-log-header");
      const la = document.getElementById("ogx-log");
      const lastLine = document.getElementById("ogx-log-last");
      const chev = document.getElementById("ogx-log-chev");
      if (lh && la) {
        const openStored = GM_getValue("ogx_log_open", "0") === "1";
        const paint = (open) => {
          la.style.display = open ? "block" : "none";
          if (lastLine) lastLine.style.display = open ? "none" : "block";
          if (chev) chev.textContent = open ? "▾" : "▸";
          if (open) updateLogUI(); // v2.94.0: the list wasn't being painted in the background
        };
        paint(openStored);
        lh.addEventListener("click", (e) => {
          if (e.target.closest("button, input")) return; // Copy/Clear work normally
          const open = la.style.display === "none";
          GM_setValue("ogx_log_open", open ? "1" : "0");
          paint(open);
        });
      }
    }
    document.getElementById("ogx-clear-logs").addEventListener("click", () => {
      logEntries = [];
      GM_setValue(LOG_STORAGE_KEY, "[]");
      const ta = document.getElementById("ogx-log-textarea");
      if (ta) { ta.value = ""; ta.style.display = "none"; }
      updateLogUI();
    });

    document.getElementById("ogx-copy-logs").addEventListener("click", () => {
      const text = logEntries
        .map(e => `[${e.time}] [${e.type.toUpperCase()}] ${e.msg}`)
        .join("\n");
      const ta = document.getElementById("ogx-log-textarea");
      if (ta) {
        ta.value = text;
        ta.style.display = ta.style.display === "none" ? "block" : "none";
        if (ta.style.display === "block") {
          ta.select();
          try {
            navigator.clipboard.writeText(text).then(() => {
              const btn = document.getElementById("ogx-copy-logs");
              if (btn) { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
            }).catch(() => {});
          } catch(e) {}
        }
      }
    });

    // Display persisted logs from previous page navigations
    updateLogUI();

    // ── v2.11.0 accordion: section titles collapse their body ──
    // With two modules + anti-detection + quick actions + log the panel got
    // crowded; click a title to fold a section (ON/OFF buttons still work —
    // clicks on buttons don't toggle). Collapsed set persists across pages.
    try {
      // v2.65.1: sections are settings — collapsed by DEFAULT (the state is shown
      // by the bar at the top). New titles = the old collapse record doesn't match,
      // so without the NEW key we collapse everything except Quick actions.
      let collapsed;
      {
        const raw = GM_getValue("ogx_ui_collapsed_v2", null);
        if (raw) collapsed = new Set(JSON.parse(raw));
        else {
          collapsed = new Set([...panel.querySelectorAll(".section .section-title span")]
            .map(el => (el.textContent || "").trim())
            .filter(n => n && n !== "Quick actions"));
        }
      }
      panel.querySelectorAll(".section").forEach(sec => {
        const title = sec.querySelector(".section-title");
        if (!title) return;
        const name = (title.querySelector("span")?.textContent || "").trim();
        if (!name) return;
        title.style.cursor = "pointer";
        const chev = document.createElement("span");
        chev.textContent = collapsed.has(name) ? "▸" : "▾";
        chev.style.cssText = "margin-right:6px;font-size:10px;color:#7f8c8d;";
        title.insertBefore(chev, title.firstChild);
        const apply = () => {
          const fold = collapsed.has(name);
          chev.textContent = fold ? "▸" : "▾";
          Array.from(sec.children).forEach(ch => {
            if (ch !== title) ch.style.display = fold ? "none" : "";
          });
        };
        apply();
        title.addEventListener("click", (e) => {
          if (e.target.closest("button, input")) return; // toggles/inputs keep working
          if (collapsed.has(name)) collapsed.delete(name); else collapsed.add(name);
          GM_setValue("ogx_ui_collapsed_v2", JSON.stringify([...collapsed]));
          apply();
        });
      });
    } catch {}

    // v2.10.27: keep the status lines fresh (lock countdowns, tab role) —
    // runs in passive tabs too; peek() is read-only so this never steals
    // leadership.
    setInterval(updateStatusUI, 5000);
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  let _logPersistTimer = null;
  function persistLogsNow() {
    if (_logPersistTimer) { clearTimeout(_logPersistTimer); _logPersistTimer = null; }
    GM_setValue(LOG_STORAGE_KEY, JSON.stringify(logEntries));
  }
  function schedulePersistLogs() {
    if (_logPersistTimer) return;
    _logPersistTimer = setTimeout(persistLogsNow, 1000);
  }
  window.addEventListener("pagehide", persistLogsNow);

  // v2.97.2: report buttons (target base, top targets) write to the log, which
  // is collapsed by DEFAULT at the bottom of the panel - "I click and nothing
  // happens" (owner 15.08 18:53). Open the log and scroll the panel to the result.
  function openLogPanel() {
    const la = document.getElementById("ogx-log");
    if (!la) return;
    GM_setValue("ogx_log_open", "1");
    la.style.display = "block";
    const lastLine = document.getElementById("ogx-log-last");
    if (lastLine) lastLine.style.display = "none";
    const chev = document.getElementById("ogx-log-chev");
    if (chev) chev.textContent = "\u25be";
    updateLogUI();
    try { la.scrollIntoView({ block: "nearest" }); } catch {}
  }

  function updateLogUI() {
    const logArea = document.getElementById("ogx-log");
    if (!logArea) return;

    // v2.65.2: shortcut — the last line is always visible, without expanding
    const last = document.getElementById("ogx-log-last");
    if (last && logEntries[0]) {
      const e = logEntries[0];
      last.textContent = `${e.time} ${e.msg}`;
      last.className = `log-entry ${e.type}`;
      last.style.cssText = "font-size:10px;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:1px 2px;";
    }

    // All logs in main area (increased limit)
    // v2.94.0: log collapsed by default (display:none) - rebuilding 50 entries
    // with escapeHTML per line was invisible work; we skip it,
    // until the operator expands the log (paint() then calls updateLogUI).
    if (logArea.style.display !== "none") logArea.innerHTML = logEntries
      .slice(0, 50)
      .map((e) => `<div class="log-entry ${e.type}">${escapeHTML(e.time)} ${escapeHTML(e.msg)}</div>`)
      .join("");

    // Pinned area: last 5 important logs (error/success/fleet) — never buried by scan spam
    const pinned = document.getElementById("ogx-log-pinned");
    if (!pinned) return;
    const important = logEntries.filter(e => e.type === "error" || e.type === "success" || e.type === "fleet").slice(0, 5);
    if (important.length > 0) {
      pinned.style.display = "block";
      pinned.innerHTML = important
        .map((e) => `<div class="log-entry ${e.type}">${escapeHTML(e.time)} ${escapeHTML(e.msg)}</div>`)
        .join("");
    } else {
      pinned.style.display = "none";
    }
  }

  // ── v2.65.0: status bar — the data is already computed, here we only DISPLAY it ──
  function updateStatusStrip() {
    const set = (id, cls, html) => {
      const row = document.getElementById(id);
      if (!row) return;
      row.className = `strip-row ${cls}`;
      row.querySelector(".val").innerHTML = html;
    };
    try {
      // 🛡 Defense
      const ts = ThreatMonitor.state();
      const active = ThreatMonitor.active();
      const s12 = ThreatLog.summary(12);
      if (!CONFIG.threatAlarm?.enabled) set("ogx-strip-def", "dim", "disabled");
      else if (active) set("ogx-strip-def", "alert", `ALARM — <b>${ts?.count ?? "?"}</b> foreign fleets`);
      else set("ogx-strip-def", "ok", `clear · 12h: ${s12.alarms ? `<b>${s12.alarms}</b> alarm${s12.saves ? `, <b>${s12.saves}</b> rescue` : ""}${s12.returns ? `, <b>${s12.returns}</b> return` : ""}` : "quiet"}`);

      // ⛏ Mining
      const scan = ScanState.load();
      const flights = MiningFlights.count();
      const maxF = maxMiningFleets();
      const flightsStr = `flights <b>${flights}</b>/${maxF > 0 ? maxF : "∞"}`;
      const returnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0")) || 0;
      if (!CONFIG.asteroidMining.enabled) set("ogx-strip-min", "dim", "disabled");
      else if (Humanizer.isOnBreak()) set("ogx-strip-min", "dim", `break (coffee) · ${flightsStr}`);
      else if (AntiDetection.isSleepTime()) set("ogx-strip-min", "dim", `night window · ${flightsStr}`);
      else if (scan?.active) {
        const next = scan.queue?.[0];
        set("ogx-strip-min", "busy", `scan <b>${scan.scannedCount ?? "?"}</b>/${scan.totalCount ?? "?"}${next ? ` · [${next.galaxy}:${next.system}]` : ""} · ${flightsStr}`);
      } else if (returnAt > Date.now()) {
        set("ogx-strip-min", "busy", `waiting for fleet ~<b>${Math.max(1, Math.ceil((returnAt - Date.now()) / 60000))}</b> min · ${flightsStr}`);
      } else set("ogx-strip-min", "ok", `on watch · ${flightsStr}`);

      // 🚀 Expeditions
      const slots = ExpeditionRunner.slots();
      const est = ExpeditionState.load();
      const gapLeft = est?.lastSendAt ? Math.max(0, Math.round(((est.lastSendAt + (est.nextGapMs || 0)) - Date.now()) / 1000)) : null;
      // v2.79.0: "next ~30 s" while dispatches are held is a lie —
      // the strip should say we're standing still and why (defense or fuel reserve).
      const holdWhy = DefenceHold.reason();
      const fuelLow = !holdWhy && Fuel.reserve() > 0 && Fuel.read() != null && Fuel.read() <= Fuel.reserve();
      if (!CONFIG.expeditions.enabled) set("ogx-strip-exp", "dim", "disabled");
      else if (holdWhy) set("ogx-strip-exp", "alert", `HELD — ${holdWhy}`);
      else if (fuelLow) set("ogx-strip-exp", "alert", "HELD — deuterium at the evacuation reserve level");
      else set("ogx-strip-exp", slots.used >= (slots.total || 14) ? "ok" : "busy",
        `<b>${slots.used ?? "?"}</b>/${slots.total || "?"}${gapLeft !== null && slots.used < (slots.total || 14) ? ` · next ~<b>${gapLeft}</b> s` : ""} · today ${est?.sentToday ?? 0}`);

      // 🌙 Fleet Save
      const fsSt = FleetSave.state();
      if (!CONFIG.fleetSave?.enabled) set("ogx-strip-fs", "dim", "disabled");
      else if (fsSt?.phase === "launched") set("ogx-strip-fs", "busy", FleetSave.describe().replace(/^FS:\s*/, ""));
      else if (fsSt?.phase === "recalled") set("ogx-strip-fs", "ok", FleetSave.describe().replace(/^FS:\s*/, ""));
      else if (fsSt?.phase === "recall_failed") set("ogx-strip-fs", "alert", "recall FAILED — check the log");
      else set("ogx-strip-fs", "ok", FleetSave.describe().replace(/^FS:\s*/, ""));

      // 🤖 Gemini
      if (!LlmParser.enabled()) set("ogx-strip-llm", "dim", "no key");
      else set("ogx-strip-llm", "ok", `active · today <b>${LlmParser._usedToday()}</b>/${LlmParser.DAILY_LIMIT}`);
    } catch {}
  }

  function updateStatusUI() {
    updateStatusStrip();
    const astStatus = document.getElementById("ogx-asteroid-status");
    if (!astStatus) return;

    const scanState = ScanState.load();
    let text = "Idle";

    if (scanState?.active) {
      const { scannedCount, totalCount, queue } = scanState;
      const next = queue?.[0];
      text = `Scanning: ${scannedCount}/${totalCount} systems`;
      if (next) text += ` | Next: [${next.galaxy}:${next.system}]`;
    } else if (scanState?.foundAsteroid) {
      text = `FOUND: ${scanState.foundAsteroid.label} — dispatching...`;
    }

    astStatus.textContent = text;

    // v2.10.0: right-sizing / parallel status line
    const sizing = document.getElementById("ogx-asteroid-sizing");
    if (sizing) {
      const am = CONFIG.asteroidMining;
      const cargo = AsteroidYieldTracker.cargoPerMiner();
      const est = AsteroidYieldTracker.expectedResources();
      const need = AsteroidYieldTracker.minersNeeded();
      const inflight = miningInflightCount();
      const maxFleets = maxMiningFleets();
      const mode = am.parallelDispatch ? "parallel" : "serial";
      const needStr = need > 0 ? need.toLocaleString() : "all";
      const cargoStr = cargo > 0 ? cargo.toLocaleString() : "?";
      const estStr = est > 0 ? est.toLocaleString() : "?";
      const flightsStr = maxFleets > 0 ? `${inflight}/${maxFleets}` : `${inflight}/∞`;
      sizing.textContent = `Mode: ${mode} | per flight: ${needStr} | flights: ${flightsStr} | cargo/miner: ${cargoStr} | est: ${estStr}`;
    }

    // v2.10.27: transparency line — which tab runs the bot + which coords are
    // currently locked (and when each frees up). This is the view that would
    // have shown today's duplicate incidents at a glance.
    const locks = document.getElementById("ogx-asteroid-locks");
    if (locks) {
      const role = TabLock.peek(); // read-only — must NOT claim from a passive tab
      const roleStr = role === "leader" ? "ACTIVE (this tab)" : role === "passive" ? "PASSIVE (other tab runs)" : "unclaimed";
      const blocked = DispatchedAsteroids.entries()
        .map(e => `[${e.coord}] ${Math.max(0, Math.ceil((e.freeAt - Date.now()) / 60000))}m`)
        .join(", ");
      locks.textContent = `Tab: ${roleStr}${blocked ? ` | locked: ${blocked}` : " | locked: none"}`;
      locks.style.color = role === "passive" ? "#e67e22" : "#7f8c8d";
    }

    // v2.11.0: inactive-farming status line
    const farmStatus = document.getElementById("ogx-farm-status");
    if (farmStatus) {
      const cfg = CONFIG.inactiveFarming;
      let ftext = "Idle";
      if (!cfg.enabled) {
        ftext = "Off";
      } else if (InactiveFarmer.yieldsToMining()) {
        ftext = "Waiting — mining has priority (asteroid scan/dispatch); farming will return once miners are in flight";
      } else if (!InactiveFarmer.parseRanges(cfg.ranges).length) {
        ftext = "No valid ranges — set e.g. 3:100-200";
      } else {
        const st = FarmState.load();
        const free = InactiveFarmer.slotsFree();
        const totalSlots = InactiveFarmer.cachedFleetTotal() || "?";
        const dbStats = FarmTargetDB.stats(cfg.maxTargetRank || 0);
        const dbTxt = `db: ${dbStats.eligible}/${dbStats.total} targets${cfg.maxTargetRank ? ` ≤${cfg.maxTargetRank}` : ""}`;
        if (st?.active) {
          const kind = st.mode === "lap" ? "Lap" : "Full scan";
          ftext = `${kind} ${st.scannedCount}/${st.totalCount} | targets queued: ${st.targets?.length ?? 0} | ${dbTxt} | slots free: ${free}/${totalSlots} | attacked (cooldown): ${FarmedTargets.count()}`;
        } else {
          const cool = parseInt(GM_getValue("ogamex_farm_cooldown_until", "0")) || 0;
          const coolMin = cool > Date.now() ? Math.ceil((cool - Date.now()) / 60000) : 0;
          ftext = coolMin > 0
            ? `Sweep done — next in ~${coolMin}min | ${dbTxt} | attacked (cooldown): ${FarmedTargets.count()}`
            : `Ready — sweep starts on next tick | ${dbTxt} | slots free: ${free}/${totalSlots}`;
        }
      }
      farmStatus.textContent = ftext;
    }

    // v2.15.0: threat banner + status line
    {
      const banner = document.getElementById("ogx-threat-banner");
      const tStatus = document.getElementById("ogx-threat-status");
      const st = ThreatMonitor.state();
      const active = ThreatMonitor.active();
      if (banner) {
        if (active) {
          const mins = Math.floor((Date.now() - (st.firstAt || st.seenAt)) / 60000);
          banner.style.display = "block";
          banner.textContent = `⚠ FOREIGN FLEET INBOUND — ${st.count} (mission bar: ${st.own}/${st.total} ours). Detected ${mins}min ago. Farming and expedition waves on hold. CHECK THE GAME.`;
        } else {
          banner.style.display = "none";
        }
      }
      if (tStatus) {
        tStatus.textContent = !CONFIG.threatAlarm?.enabled
          ? "Off"
          : active
            ? `ALARM: ${st.count} foreign fleets`
            : "Clear — no foreign fleets in the mission bar";
        tStatus.style.color = active ? "#e74c3c" : "#999";
      }
      const tlStatus = document.getElementById("ogx-threatlog-status");
      if (tlStatus) {
        // v2.47.0: the first line should answer the question "what happened while
        // I was asleep", not report the number of entries.
        const s12 = ThreatLog.summary(12);
        const all = ThreatLog.all();
        tlStatus.textContent = `Last ${s12.text}`
          + (s12.lastSave ? ` | rescue: ${s12.lastSave}` : "")
          + (s12.lastReturn ? ` | return: ${s12.lastReturn}` : "")
          + ` | entries: ${all.length}`;
        tlStatus.style.color = (s12.alarms || s12.errors) ? "#e74c3c" : "#7f8c8d";
      }

      const msStatus = document.getElementById("ogx-moonsave-status");
      if (msStatus) {
        const ms = MoonSave.state();
        const mw = MoonSave.watch();
        msStatus.textContent = !MoonSave.armed()
          ? "Moon target unknown — just click RESCUE FLEET, the bot will go to the base galaxy and read it itself"
          : mw.armed
            ? `MULTI-WAVE GUARD (${mw.trigger === "threat" ? "alert" : "manual"}): fleet on ${mw.refugeBody === "moon" ? "moon" : "planet"}, base ${mw.homeBody === "moon" ? "moon" : "planet"} kept empty, ${mw.saves || 0} save(s) every ~${Math.round(MoonSave.MIN_RESAVE_MS / 1000)}s. ${mw.trigger === "threat" ? "Returns on its own once foreign fleets leave the bar." : "Manual rescue — return ONLY via the RETURN TO BASE button."}`
            : ms.at
              ? `Ready. Last rescue: ${Math.round((Date.now() - ms.at) / 60000)}min ago (${ms.reason || "?"})`
              : "Ready — moon target learned. Automatic mode OFF (waiting to distinguish attack from probes).";
        msStatus.style.color = mw.armed ? "#e74c3c" : MoonSave.armed() ? "#7f8c8d" : "#e67e22";
      }
    }

    // v2.60.0: Fleet Save status line
    const fsStatus = document.getElementById("ogx-fs-status");
    if (fsStatus) {
      const st = FleetSave.state();
      fsStatus.textContent = CONFIG.fleetSave?.enabled || st ? FleetSave.describe() : "Off";
      fsStatus.style.color = st?.phase === "recall_failed" ? "#e74c3c"
        : st?.phase === "launched" || st?.phase === "recalled" ? "#2ecc71"
        : CONFIG.fleetSave?.enabled ? "#e67e22" : "#7f8c8d";
    }

    // v2.14.0: expedition status line
    const expoStatus = document.getElementById("ogx-expo-status");
    if (expoStatus) {
      const cfg = CONFIG.expeditions;
      let etext;
      if (!cfg.enabled) {
        etext = "Off";
      } else if (!FleetRecon.expeditionLink()) {
        etext = "Waiting for the expedition link — go to Galaxy once";
      } else if (!ExpeditionRunner.base()) {
        etext = "I don't know the start point — open the planet list page";
      } else {
        const s = ExpeditionRunner.slots();
        const nextMs = ExpeditionRunner.msToNextWave();
        const eb = ExpeditionRunner.base();
        const parts = [`in the air: ${s.used}/${s.total || "?"} (cap ${ExpeditionRunner.waveCap()})`];
        parts.push(nextMs > 0 ? `next wave in ~${Math.ceil(nextMs / 1000)}s` : "wave ready");
        parts.push(`today: ${ExpeditionRunner.sentToday()}`);
        if (eb) parts.push(eb.fixed ? `start: [${eb.galaxy}:${eb.system}:${eb.position}] (fixed)` : `start: [${eb.galaxy}:${eb.system}:${eb.position}] (where you are)`);
        etext = parts.join(" | ");
      }
      expoStatus.textContent = etext;
    }

    // v2.13.0: online-bonus status line
    const bonusStatus = document.getElementById("ogx-bonus-status");
    if (bonusStatus) {
      if (!CONFIG.onlineBonus?.enabled) {
        bonusStatus.textContent = "Off";
        bonusStatus.style.color = "#7f8c8d";
      } else {
        const last = OnlineBonus.lastClaimAt();
        const parts = [`claimed today: ${OnlineBonus.claimsToday()}`];
        parts.push(last ? `last: ${Math.max(0, Math.round((Date.now() - last) / 60000))}min ago` : "last: never");
        const nextTry = parseInt(GM_getValue(OnlineBonus.KEY_NEXT_TRY, "0")) || 0;
        if (nextTry > Date.now()) parts.push(`next check in ${Math.ceil((nextTry - Date.now()) / 60000)}min`);
        else parts.push("watching");
        bonusStatus.textContent = parts.join(" | ");
        bonusStatus.style.color = "#999";
      }
    }

    // v2.12.0: humanizer status line
    const humStatus = document.getElementById("ogx-humanizer-status");
    if (humStatus) {
      const parts = [];
      if (Humanizer.isOnBreak()) {
        parts.push(`ON BREAK — ${Humanizer.breakLeftMin()}min left`);
      } else if (CONFIG.humanizer.breaks) {
        const next = parseInt(GM_getValue("ogamex_next_break_at", "0")) || 0;
        parts.push(next > Date.now() ? `next break in ~${Math.ceil((next - Date.now()) / 60000)}min` : "break due");
      } else {
        parts.push("breaks off");
      }
      const lim = CONFIG.humanizer.maxAttacksPerDay || 0;
      parts.push(`attacks today: ${Humanizer.attacksToday()}${lim > 0 ? `/${lim}` : ""}`);
      humStatus.textContent = parts.join(" | ");
      humStatus.style.color = Humanizer.isOnBreak() ? "#e67e22" : "#7f8c8d";
    }
  }

  function makeDraggable(element, handle) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    handle.addEventListener("mousedown", (e) => {
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = element.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      element.style.left = startLeft + (e.clientX - startX) + "px";
      element.style.top = startTop + (e.clientY - startY) + "px";
      element.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═══════════════════════════════════════════════════════════════

  function init() {
    // Wait for page to be fully loaded
    if (document.readyState !== "complete") {
      window.addEventListener("load", init);
      return;
    }

    // v2.10.11: OGameX served its own "Error occurred / Page not found" page?
    // Recover (→ Back to game) BEFORE anything else and bail — leaving miners
    // grounded here risks them being scrapped. Also resets the streak when
    // we're on a normal game page.
    if (handleErrorPageIfPresent()) {
      return;
    }

    // v2.96.0: the operator browses messages -> harvest data from visible
    // combat reports (works even without a confirmed fetch endpoint).
    try { CombatWatch.harvestDom(); } catch {}
    try { PlunderWatch.harvestDom(); } catch {} // v2.97.0: profile = free loot samples
    // v2.97.1: journal tabs (days) and report pages switch
    // WITHOUT a reload — harvest in init only saw the first view.
    // Re-reading every 15 s is idempotent (dedup by coord|date) and cheap;
    // it also lets you SUCK IN THE HISTORY: the owner clicks through the days 09.08-today on
    // the profile, and each view loads into the loot database within seconds.
    setInterval(() => {
      try { CombatWatch.harvestDom(); } catch {}
      try { PlunderWatch.harvestDom(); } catch {}
    }, 15 * 1000);

    // Only run on game pages — NOT the landing/lobby page (/ or /home). v2.10.21:
    // the user is still LOGGED IN here (confirmed: no password, they just click a
    // "Play / Enter game" button to re-enter and land on Overview). So the right
    // recovery is to CLICK that button — NOT reload (the landing page just shows
    // itself again; observed reloading it 10× over ~1.5h with zero progress) and
    // NOT navigate to /overview cold (that returns OGameX's error page, feeding
    // the error→Back-to-game→landing loop). We don't yet know the exact button,
    // so dump all clickables to the (persisted) log AND try a text match.
    // v2.10.22: only the LOGGED-OUT landing/login page is skipped. When logged
    // in, "/" and "/home" are the game's Overview/home — fall through and run
    // (build the panel, start the scheduler → it navigates to galaxy to scan).
    // Without this the bot was invisible & idle on Overview, the very page the
    // error-recovery lands on, so it never resumed until the user opened
    // Fleet/Galaxy by hand.
    const onLandingPath = window.location.pathname.includes("/home") || window.location.pathname === "/";
    if (onLandingPath && !isLoggedInGamePage()) {
      if (CONFIG.enabled) {
        const now = Date.now();
        const lastAt = parseInt(GM_getValue("ogamex_login_retry_at", "0"));
        let streak = (lastAt && now - lastAt < 20 * 60 * 1000) ? parseInt(GM_getValue("ogamex_login_retry_streak", "0")) + 1 : 0;
        GM_setValue("ogamex_login_retry_at", String(now));
        GM_setValue("ogamex_login_retry_streak", String(streak));

        logClickables("landing-page"); // diagnostic — shows the exact buttons to target

        const entry = findGameEntryElement();
        if (entry) {
          const label = (entry.textContent || entry.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
          const delaySec = Math.min(60, 3 * Math.pow(2, Math.min(streak, 4))); // 3,6,12,24,48,60s — throttle if it keeps bouncing
          log(`On login/landing page (no game UI) — clicking "${label}" to re-enter game in ~${Math.round(delaySec)}s (attempt ${streak + 1}).`, "warn");
          setTimeout(() => {
            const href = entry.getAttribute && entry.getAttribute("href");
            if (entry.tagName === "A" && href && href !== "#") window.location.replace(entry.href);
            else entry.click();
          }, delaySec * 1000);
        } else {
          // No obvious entry button found — fall back to a reload (and the dump
          // above will tell us what to click next time). Backoff so we don't spin.
          const schedule = [2, 2, 4, 8, 15];
          const minutes = schedule[Math.min(streak, schedule.length - 1)];
          log(`On landing page — no Play/Enter button matched; reloading in ~${minutes}min (attempt ${streak + 1}). Clickables logged above — send them so I can target the button.`, "warn");
          setTimeout(() => { window.location.reload(); }, (minutes + Math.random() * 0.5) * 60 * 1000);
        }
      }
      return;
    }

    const SCRIPT_VERSION = (typeof GM_info !== "undefined" && GM_info?.script?.version) || "?";
    ApiSniffer.install(); // v2.45.0: note what the game actually uses
    // v2.47.0: once an hour, write to the log what happened over the last 12 h.
    // After the night, the first line in the log should say whether anyone flew and whether the fleet
    // fled to the moon — without browsing the journal.
    try {
      const last = parseInt(GM_getValue("ogamex_threat_digest_at", "0")) || 0;
      if (Date.now() - last > 60 * 60 * 1000) {
        GM_setValue("ogamex_threat_digest_at", String(Date.now()));
        const d = ThreatLog.summary(12);
        log(`[DEFENSE] Last ${d.text}`, d.alarms || d.errors ? "warn" : "info");
      }
    } catch {}
    log(`OGameX Assistant v${SCRIPT_VERSION} loaded`, "info");

    // v2.68.0: before the passive-tab gate — the sleep lock is held by every
    // tab with the game (the visible one counts anyway), so the leader can change
    // without losing sleep protection.
    try { WakeLock.wire(); } catch {}
    try { AudioKeepalive.ensure(); } catch {}

    // v2.10.10: timestamp of the last real page load — read by the scheduler
    // keepalive to detect long stretches with no navigation (session risk).
    GM_setValue("ogamex_last_pageload_at", String(Date.now()));

    // ── v2.10.25: non-leader tabs are passive viewers ──
    // Everything below mutates SHARED state (pending_mission, scan state,
    // fleet timers) — a second open game tab executing it was the root cause
    // of the 3-fleets-to-one-asteroid incident. A passive tab still builds the
    // panel and starts the (leader-gated) scheduler, so it takes over
    // automatically within ~3min if the active tab closes.
    if (!TabLock.isLeader()) {
      log("Another tab is running the bot — this tab stays PASSIVE (will take over if the active tab closes).", "warn");
      createUI();
      updateStatusUI();
      // v2.69.1: the defense-watcher also stands watch in the passive tab (requireLeader
      // only lets the leader act anyway — this is takeover readiness).
      if (CONFIG.enabled) startScheduler();
      startDefenceLoop();
      return;
    }
    // Leader heartbeat, independent of the 50-90s scheduler cadence. When this
    // tab owns the lock isLeader() refreshes it; when another fresh tab owns
    // it, isLeader() is a read-only false — no write war.
    setInterval(() => TabLock.isLeader(), TabLock.HEARTBEAT_MS);

    // ── v2.25.3: learn the moon target ON PAGE LOAD ──
    // It used to depend on the scheduler tick reaching ThreatMonitor.check()
    // while we happened to be standing on the base system's galaxy page. The
    // asteroid scanner starts a sweep within seconds of that page loading and
    // navigates away, and a jitter pause can swallow the tick entirely (a 13min
    // one landed on the very click that triggered this). Doing it at load
    // removes the race: the page we arrived at is the page we read.
    if (GameState.getCurrentPage() === "galaxy") {
      ThreatMonitor.dumpBaseRowOnce();
      MoonSave.resumeAfterLearn();
    }
    // v2.38.3: the events block is on the fleet page — catch it on load,
    // without waiting for a tick that does nothing during a break anyway.
    ThreatMonitor.dumpEventsFromDom();

    // v2.11.0: cache the fleet-slot TOTAL ("Fleets: X/37") — visible only on
    // the fleet page; the farmer's slot budget needs it on galaxy pages.
    // v2.13.1: superseded by FleetRecon.scan() on fleet pages (it caches the
    // same key plus ship types, fleet groups and expedition slots). The plain
    // regex stays for every OTHER page that happens to show the counter.
    if (GameState.getCurrentPage() === "fleet") {
      FleetRecon.scan();
    } else if (GameState.getCurrentPage() === "galaxy") {
      // One-shot: learn the Expedition link from row 16 (no-op once known).
      FleetRecon.learnExpeditionLink();
      const ftm = document.body.textContent.match(/Fleets:\s*\d+\s*\/\s*(\d+)/);
      if (ftm) GM_setValue("ogamex_fleet_total_slots", ftm[1]);
    } else {
      const ftm = document.body.textContent.match(/Fleets:\s*\d+\s*\/\s*(\d+)/);
      if (ftm) GM_setValue("ogamex_fleet_total_slots", ftm[1]);
    }

    // ── Handle fleetSendSuccessfully page (race condition fix) ──
    // When "Send fleet" is clicked, OGameX navigates the browser to this URL
    // BEFORE our JS finishDispatch() can run, so pending_mission is never cleared.
    // Fix it here — immediately clear pending_mission and foundAsteroid so that
    // the scheduled handlePendingMission below is a no-op (won't attempt re-dispatch).
    //
    // v2.10.0: this is ALSO the usual place the parallel-vs-wait decision is
    // made, because the browser navigates here before finishDispatch can run.
    // parallelKeepScanning is read by the fleet-timer block below to avoid
    // re-pausing the scan we just decided to continue.
    let parallelKeepScanning = false;
    let wasExpoSend = false; // v2.15.2: read by the fleet-timer block below
    let wasRecycleSend = false; // v2.59.0: same — debris is not a mining flight
    let wasFsSend = false;      // v2.60.0: same — Fleet Save
    if (window.location.href.includes("fleetSendSuccessfully")) {
      // v2.11.0: was this a FARM send? The browser navigated here before
      // finishDispatch could run, so pending_mission still carries the type.
      // Farm sends must NOT run the mining parallel-decision below.
      let wasFarmSend = false;
      let wasMoonSend = false;
      let wasMoonReturn = false;
      let wasFerry = false;
      let pmSnap = null; // v2.85.0: the in-air escape reads the mission after the slot is cleared
      try {
        const pm = JSON.parse(GM_getValue("pending_mission", "null"));
        pmSnap = pm;
        wasFarmSend = !!pm?.farm;
        wasExpoSend = !!pm?.expedition;
        wasMoonSend = !!pm?.moonSave;
        wasMoonReturn = !!pm?.moonReturn;
        wasFerry = !!pm?.ferry;
        wasRecycleSend = !!pm?.recycle;
        wasFsSend = !!pm?.fleetSave;
      } catch {}
      // v2.14.0: slow-navigation twin of the farm check below — if
      // finishDispatch already cleared pending_mission, the send stamp still
      // carries the kind, so an expedition never falls into the mining branch.
      if (!wasExpoSend) {
        const ls = readLastSent();
        wasExpoSend = !!(ls?.expedition && Date.now() - (ls.at || 0) < 60000);
      }
      if (wasMoonSend) {
        // v2.26.3: a fleet save / return is not a mining flight and must not be
        // booked as one. Owner's 18:51 log shows the return leg landing here and
        // printing "PARALLEL: sent 1000000000, ~4400000000 miners still home" —
        // numbers recycled from an old mining record, on a send that moved no
        // miners to any asteroid. Beyond the nonsense in the log it also bumped
        // the in-flight fleet counter and could set a mining return timer, i.e.
        // spend the mining budget on a trip to our own moon.
        GM_setValue("pending_mission", null);
        // ── v2.33.0: THIS is where the guard disarms after the return ──
        // The disarm lived only in finishDispatch, i.e. on the path
        // that works ONLY when the click doesn't reload the page. Normally the game
        // bounces the browser to fleetSendSuccessfully and lands here —
        // and this branch (added in v2.26.3 for the mining counters) cleared
        // pending_mission and exited without touching the guard. The guard stayed
        // armed after a SUCCESSFUL return, so returnHome() fired again on
        // the next tick. Owner's log from August 2: return sent
        // at 09:26:19, then attempts at 09:27:45, 09:29:11, 09:30:23, 09:30:36
        // and 09:32:26 — all into the void, because the fleet was already en route.
        if (wasMoonReturn) {
          // v2.78.0: if a colony rescued in the same
          // alert is queued, we don't disarm the guard — we insert that colony into it
          // and let the same returnHome() pull it down on the next
          // move. Empty queue = behavior identical to 2.77.2.
          // v2.88.3: coordinates of the colony that JUST returned — the promotion rejects
          // its own stale entries (23:00 incident: the second return of that
          // same colony in the opposite direction from an entry hours earlier).
          const justAt = RescueQueue.str(MoonSave.watch()?.at);
          if (!RescueQueue.promoteNext("previous colony return finished", justAt)) {
            MoonSave.disarm("fleet returned to base (confirmed after dispatch)");
          }
        }
        // v2.74.5: stamp of the CONFIRMED rescue send — the return (returnHome)
        // waits 130 s from that moment for the landing before it moves to pull the fleet.
        if (!wasMoonReturn && !wasFerry) {
          // v2.86.5: + real rescue flight time — the landing is counted from it.
          try { const w = MoonSave.watch(); if (w.armed) MoonSave.saveWatch({ ...w, lastSendAt: Date.now(), lastFlightMs: (pmSnap && pmSnap.flightMs) || w.lastFlightMs || 0 }); } catch {}
        }
        if (wasFerry) {
          // v2.71.0: the ferry is logistics, not defense — no RESCUE/RETURN entry
          // in the journal (it would falsify the defense episode counters).
          ThreatLog.add("reading", "FERRY: planet → moon sent (transporting production/resources/fleet).");
          log("[FERRY] sent — everything from the planet flies to the moon.", "success");
        } else if (pmSnap?.airSave) {
          // v2.85.0: confirmed escape send — state stamp + journal.
          try { AirSave.afterSend(pmSnap); } catch {}
          ThreatLog.add("RESCUE", "AIR SAVE SENT — fleet in flight to the refuge, automatic recall once the attacks pass.");
          log("[AIR SAVE] the game accepted the dispatch — fleet in the air, recall on the clock.", "success");
        } else {
          ThreatLog.add(wasMoonReturn ? "RETURN" : "RESCUE", "SENT — the game accepted the fleet (confirmed after reload).");
          log("Fleet rescue/return sent — mining counters untouched.", "fleet");
        }
      } else if (wasExpoSend) {
        GM_setValue("pending_mission", null);
        const storedExp = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
        GM_setValue("ogamex_inflight_fleets", String(storedExp + 1));
        GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
        ExpeditionRunner.afterSend();
      } else if (wasFsSend) {
        // v2.60.0: the game accepted the FS dispatch and bounced us here before
        // finishDispatch could run — stamp the FS state from the mission BEFORE
        // pending_mission gets cleared.
        try {
          const pm = JSON.parse(GM_getValue("pending_mission", "null"));
          if (pm?.fleetSave) FleetSave.markLaunched(pm);
        } catch {}
        GM_setValue("pending_mission", null);
      } else if (wasRecycleSend) {
        // v2.59.0: a debris run is not a mining flight — without this branch
        // it fell through to the parallel mining decision with STALE numbers
        // of miners and inflated the counters.
        GM_setValue("pending_mission", null);
        log("[DEBRIS] recyclers en route to the debris field — mining counters untouched.", "fleet");
      } else if (wasFarmSend) {
        GM_setValue("pending_mission", null);
        // v2.11.1: bump the in-flight floor + stamp, exactly like the mining
        // path (decideAfterMiningSend) does — the page may not list the fleet
        // we sent seconds ago, and slotsFree() must not under-count near the
        // cap (it would send one fleet more than the reserve allows).
        const storedNow = parseInt(GM_getValue("ogamex_inflight_fleets", "0")) || 0;
        GM_setValue("ogamex_inflight_fleets", String(storedNow + 1));
        GM_setValue("ogamex_last_dispatch_at", String(Date.now()));
        const atkToday = Humanizer.recordAttack(); // v2.12.0: daily cap counter
        log(`Farm fleet sent (attack #${atkToday} today) — continuing with next target / sweep.`, "success");
        setTimeout(() => { InactiveFarmer.afterSend().catch(() => {}); }, 1500 + Math.random() * 1500);
        // Skip the mining post-send logic entirely — but fall through to the
        // rest of init (UI, scheduler) via this flag staying false.
      } else {
      GM_setValue("pending_mission", null);
      const afterDispatchState = ScanState.load();
      if (afterDispatchState) {
        afterDispatchState.foundAsteroid = null;
        ScanState.save(afterDispatchState);
      }
      const am = CONFIG.asteroidMining;
      let lastDisp = null;
      try { lastDisp = JSON.parse(GM_getValue("ogamex_last_dispatch", "null")); } catch {}
      // v2.12.1: slow-navigation race — if finishDispatch of a FARM send
      // already ran (cleared pending_mission) and the click-navigation landed
      // here late, wasFarmSend is false but this was NOT a mining send.
      // Running the mining decision would use STALE mining numbers and
      // double-bump the in-flight counter. The send stamp carries the kind.
      const lastSentInfo = readLastSent();
      const recentFarmSend = !!(lastSentInfo?.farm && Date.now() - (lastSentInfo.at || 0) < 60000);
      if (am.parallelDispatch && lastDisp && !recentFarmSend) {
        parallelKeepScanning = decideAfterMiningSend({
          available: lastDisp.available,
          toSend: lastDisp.toSend,
          capturedFlightMs: 0,
        });
      }
      if (parallelKeepScanning) {
        log("Fleet sent — miners + slot remain → continuing scan for more asteroids (parallel).", "asteroid");
        // v2.10.6: actually RESUME the scan here. The browser lands on
        // fleetSendSuccessfully (NOT galaxy), so the on-load galaxy-resume below
        // (requires page==='galaxy') never fires. Previously the resume was left
        // entirely to the scheduler's stranded-recovery, which is gated by
        // timing/minersInFlight/dispatchInProgress and did NOT reliably catch
        // this — so after a parallel dispatch the scan stalled in a
        // "parallel keeps scanning" reload loop and the remaining (often
        // multiple) asteroid ranges never got scanned. Navigate to the next
        // queued system now, mirroring finishDispatch's "parallel resume".
        const resumeState = ScanState.load();
        const nextSys = resumeState?.active && resumeState.queue?.length ? resumeState.queue[0] : null;
        if (nextSys) {
          GM_setValue("ogamex_fleet_return_at", "0"); // parallel: keep scanning, don't wait
          const delayMs = 1500 + Math.random() * 2000; // human-like pause before resuming
          setTimeout(() => scanNavigate(`/galaxy?x=${nextSys.galaxy}&y=${nextSys.system}`, "parallel resume (post-send)"), delayMs);
        } else {
          // v2.12.4: the comment used to SAY "let scheduler cooldown" but no
          // cooldown was ever set — the next tick restarted a full sweep of
          // the same range right after the fleet send. Set it for real.
          endSweepWithCooldown("Queue exhausted after dispatch");
        }
      } else {
        log("Fleet sent — dispatch state cleaned up. Scan paused until a fleet returns.", "asteroid");
      }
      } // end !wasFarmSend (v2.11.0)
    }

    // ── Cleanup stale data on startup ──
    GM_setValue("ogamex_tried_planets", "[]");
    GM_setValue("ogamex_last_switched_planet", "");

    // ── Smart fleet return timer check on startup ──
    // ALWAYS scan page header for active asteroid fleet, regardless of stored timer.
    // This recovers from scenarios where the timer was never persisted (e.g. dispatch
    // failure path didn't save it) — preventing the bot from scanning while miners
    // are still in flight.
    // v2.15.2: SKIP the whole block after an expedition send. It is mining
    // bookkeeping end to end, and an expedition lands on the very same
    // fleetSendSuccessfully page, so it was being dragged through it with two
    // possible outcomes, both wrong:
    //   • `justSentFleet && storedReturnAt > now` → setFleetReturnTimerFromHeader
    //     re-derived the mining timer from the FIRST countdown on the page,
    //     which after a wave belongs to an expedition. Live log:
    //     "Asteroid fleet active! Timer set: ~2min (countdown 0h0m5s ×2)".
    //   • header shows "Type: Expedition" instead of Asteroid Mining → the
    //     last branch fires "Active fleets visible but not asteroid mining.
    //     Resetting timer." and CLEARS the wait while every miner is still
    //     away — the scanner then hunts asteroids it has no ships to reach.
    // An expedition changes nothing about where the miners are, so the honest
    // move is to leave mining's state exactly as it was.
    if (wasExpoSend || wasRecycleSend || wasFsSend) {
      log(`${wasExpoSend ? "Expedition" : wasRecycleSend ? "Recycle" : "Fleet Save"} send — mining fleet timers left untouched.`, "fleet");
    } else {
      const storedReturnAt = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
      const headerText = document.body.textContent;
      const noFleetMovement = /No fleet movement/i.test(headerText);
      const hasAsteroidFleet = /Type:\s*Asteroid\s*Mining/i.test(headerText);

      const justSentFleet = window.location.href.includes("fleetSendSuccessfully");
      if (noFleetMovement && !justSentFleet) {
        // No fleets in flight at all — clear any stale timer
        // (Skip this check on fleetSendSuccessfully: the page may not yet reflect
        // the fleet we just dispatched, causing a false "no movement" read.)
        if (storedReturnAt) {
          log("No fleet movement — fleet already returned. Resetting timer.", "asteroid");
          GM_setValue("ogamex_fleet_return_at", "0");
        }
        clearInflightFleets(); // everything home — reset parallel budget (v2.10.7)
        GM_setValue("ogamex_inflight_fleets", "0"); // legacy key — keep cleared for safety
      } else if (hasAsteroidFleet || (justSentFleet && storedReturnAt && storedReturnAt > Date.now())) {
        // ── Asteroid fleet IS in flight ──
        // In parallel mode an in-flight fleet is normal — keep scanning as long
        // as there's a free fleet slot AND we're not certain we're out of miners.
        // v2.10.3: treat an UNKNOWN home count (no/stale dispatch record) as
        // "probably have miners → scan and verify at dispatch", not as zero.
        // Ground truth is the live ship count read on the fleet page at send
        // time; if it really is 0 the dispatch fail-path sets the wait. Only a
        // FRESH record proving <min miners home (e.g. right after a 100% send)
        // pauses here. v2.10.1's "unknown == wait" wrongly blocked players who
        // had miners home but no recent record.
        if (CONFIG.asteroidMining.parallelDispatch && !parallelKeepScanning) {
          const minersHome = minersHomeAfterLastDispatch(); // -1 = unknown
          const known = minersHome >= 0;
          const slots = GameState.getFleetSlots();
          const slotsFree = slots.total > 0 ? slots.total - slots.used : 1;
          const minNeeded = CONFIG.asteroidMining.minMinersPerMission || 1;
          const haveMiners = !known || minersHome >= minNeeded; // unknown → assume some
          const maxFleets = maxMiningFleets();
          const inflight = miningInflightCount(); // v2.15.1: expeditions don't spend the mining budget
          const budgetOk = maxFleets <= 0 || inflight < 0 || inflight < maxFleets; // <0 = unknown (v2.30.0)
          if (slotsFree > 0 && haveMiners && budgetOk) {
            GM_setValue("ogamex_fleet_return_at", "0"); // capacity + (likely) miners + budget → keep scanning
            const homeStr = known ? `~${minersHome}` : "unknown→verify at dispatch";
            const budgetStr = maxFleets > 0 ? `, ${inflight < 0 ? "?" : inflight}/${maxFleets} flights` : "";
            log(`Asteroid fleet in flight, ${homeStr} miners home + ${slotsFree} slot(s) free${budgetStr} — parallel keeps scanning.`, "asteroid");
          } else {
            const why = !budgetOk ? `flight budget reached (${inflight < 0 ? "?" : inflight}/${maxFleets})`
              : !haveMiners ? `no miners home (${minersHome})`
              : "fleet slots full";
            log(`Parallel: ${why} → wait for fleet return.`, "asteroid");
            setFleetReturnTimerFromHeader(headerText, storedReturnAt);
          }
        } else if (!parallelKeepScanning) {
          // Serial mode: always (re)compute the wait timer from the page header.
          setFleetReturnTimerFromHeader(headerText, storedReturnAt);
        }
        // parallelKeepScanning === true → decideAfterMiningSend already cleared the gate.
      } else if (storedReturnAt && storedReturnAt > Date.now()) {
        // Timer exists but no asteroid fleet visible — could be stale OR page just doesn't show it
        // Be conservative: only reset if there are NO fleets in flight at all
        // (we already checked noFleetMovement above; if we're here, something is in flight but not asteroid)
        log("Active fleets visible but not asteroid mining. Resetting timer.", "asteroid");
        GM_setValue("ogamex_fleet_return_at", "0");
      }
    }

    createUI();
    updateStatusUI();

    // v2.10.0: learn expected asteroid yield from mission reports (no-op unless
    // we're on a message-like page; fully guarded).
    AsteroidYieldTracker.scanReports();

    // v2.17.1: check the bonus BEFORE the galaxy-scan resume below. That resume
    // navigates 1.5s after load and the scheduler's first tick only arrives at
    // 3-8s — on a tab that is actively scanning, the claim never got a page
    // that lived long enough. Claiming is a single navigation, so going early
    // costs one scan step at most.
    if (CONFIG.enabled) {
      setTimeout(() => { OnlineBonus.run().catch(() => {}); }, 200 + Math.random() * 250);
    }

    // Handle pending missions from previous page (fleet dispatch flow)
    setTimeout(handlePendingMission, 2000);

    // ── Handle active galaxy scan on page load ──
    // If we're on galaxy page and there's an active scan, continue scanning
    // BUT only if miners are NOT in flight
    const scanState = ScanState.load();
    const fleetReturnCheck = parseInt(GM_getValue("ogamex_fleet_return_at", "0"));
    if (fleetReturnCheck && Date.now() < fleetReturnCheck) {
      const waitMin2 = Math.ceil((fleetReturnCheck - Date.now()) / 60000);
      log(`Miners in flight (~${waitMin2}min left). Scan paused — will resume on return.`, "delay");
      // DO NOT clear ScanState — preserve the queue so scan can resume after fleet returns.
      // The scheduler's stranded-scan logic will navigate to galaxy once the timer expires.
    } else if (scanState?.active && GameState.getCurrentPage() === "galaxy" && CONFIG.enabled && CONFIG.asteroidMining.enabled) {
      log("Resuming galaxy scan...", "asteroid");
      // Delay to let the page fully render galaxy items
      // v2.48.0: if this is the base system's galaxy, check the debris field first.
      try { if (DebrisCollector.tryCollectHere()) return; } catch {}
      setTimeout(() => AsteroidMiner.run(), 1500 + Math.random() * 1000); // v2.10.18: trimmed (galaxy items are server-rendered, present on load)
    } else if (CONFIG.enabled && CONFIG.inactiveFarming?.enabled && !InactiveFarmer.yieldsToMining()
               && FarmState.load()?.active && GameState.getCurrentPage() === "galaxy") {
      // v2.11.0: farm sweep continues on galaxy page load (mirror of the
      // asteroid resume above; farmer no-ops if a pending_mission exists).
      // v2.90.0: instead of "mining disabled" — a priority gate (farming resumes
      // on the galaxy only in the window when mining is waiting for miners anyway).
      setTimeout(() => { InactiveFarmer.run().catch(() => {}); }, 1500 + Math.random() * 1000);
    }

    // Auto-start scheduler if enabled
    // v2.69.1: the defense loop starts ALWAYS — with the bot OFF in
    // observer mode (detection+journal+push, zero fleet movement).
    if (CONFIG.enabled) startScheduler();
    startDefenceLoop();
    if (!CONFIG.enabled) log("Bot OFF — the defense stands watch in OBSERVER MODE (detects and alerts, doesn't move the fleet).", "info");

    // v2.10.10 watchdog: the scheduler is a chained setTimeout — if one tick
    // ever throws an uncaught error (or the chain dies any other way), the
    // bot goes permanently silent with NO log line, because during a cooldown
    // nothing else ever reloads the page. This interval is independent of the
    // chain and its callback is trivial, so it can't die the same way. Max
    // legit tick gap is ~17min (15min jitter pause + 90s interval), so 25min
    // of silence means the chain is dead → reload restarts everything.
    setInterval(() => {
      if (!CONFIG.enabled) return;
      const lastTick = parseInt(GM_getValue("ogamex_last_tick_at", "0"));
      if (lastTick && Date.now() - lastTick > 25 * 60 * 1000) {
        log("Watchdog: no scheduler tick for >25min — scheduler chain dead. Reloading.", "warn");
        window.location.reload();
      }
    }, 60 * 1000);
  }

  init();
})();
