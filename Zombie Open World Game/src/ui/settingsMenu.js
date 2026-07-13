/** User-adjustable gameplay settings for DeadTakeover.
 *
 *  Loaded once at startup and persisted to localStorage on every change.
 *  main.js consumes the returned settings object directly (mouse-look,
 *  FOV, feedback toggles), so mutations here take effect immediately.
 */

const STORAGE_KEY = "zowg_settings";

export const DEFAULT_USER_SETTINGS = {
  /** Mouse-look multiplier applied to both axes. */
  sensitivity: 1.0,
  /** Hip-fire field of view in degrees. ADS zoom scales from this. */
  fov: 75,
  /** Camera shake on impacts/explosions (accessibility). */
  screenShake: true,
  /** Floating damage numbers over enemies. */
  damageNumbers: true,
};

const LIMITS = {
  sensitivity: { min: 0.2, max: 3 },
  fov: { min: 60, max: 100 },
};

function clampNumber(value, fallback, { min, max }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadUserSettings() {
  const settings = { ...DEFAULT_USER_SETTINGS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      settings.sensitivity = clampNumber(parsed.sensitivity, settings.sensitivity, LIMITS.sensitivity);
      settings.fov = clampNumber(parsed.fov, settings.fov, LIMITS.fov);
      if (typeof parsed.screenShake === "boolean") settings.screenShake = parsed.screenShake;
      if (typeof parsed.damageNumbers === "boolean") settings.damageNumbers = parsed.damageNumbers;
    }
  } catch { /* corrupted/blocked storage — fall back to defaults */ }
  return settings;
}

export function saveUserSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* quota / privacy mode — silent fail */ }
}

/** Build the settings panel DOM (hidden by default) and return
 *  { panel, refresh }. `onChange(settings)` fires after every edit;
 *  the caller persists and applies the new values. */
export function createSettingsPanel(settings, onChange) {
  const panel = document.createElement("div");
  panel.id = "settings-panel";
  panel.className = "settings-panel is-hidden";
  panel.innerHTML = `
    <div class="settings-row">
      <label for="setting-sensitivity">Mouse sensitivity</label>
      <input type="range" id="setting-sensitivity" min="${LIMITS.sensitivity.min}" max="${LIMITS.sensitivity.max}" step="0.05" />
      <span class="settings-value" id="setting-sensitivity-value"></span>
    </div>
    <div class="settings-row">
      <label for="setting-fov">Field of view</label>
      <input type="range" id="setting-fov" min="${LIMITS.fov.min}" max="${LIMITS.fov.max}" step="1" />
      <span class="settings-value" id="setting-fov-value"></span>
    </div>
    <div class="settings-row settings-row-toggle">
      <label for="setting-shake">Screen shake</label>
      <input type="checkbox" id="setting-shake" />
    </div>
    <div class="settings-row settings-row-toggle">
      <label for="setting-dmgnums">Damage numbers</label>
      <input type="checkbox" id="setting-dmgnums" />
    </div>
    <button type="button" id="setting-reset" class="settings-reset">Reset to defaults</button>
  `;

  const sensitivityEl = panel.querySelector("#setting-sensitivity");
  const sensitivityValueEl = panel.querySelector("#setting-sensitivity-value");
  const fovEl = panel.querySelector("#setting-fov");
  const fovValueEl = panel.querySelector("#setting-fov-value");
  const shakeEl = panel.querySelector("#setting-shake");
  const damageNumbersEl = panel.querySelector("#setting-dmgnums");
  const resetEl = panel.querySelector("#setting-reset");

  function refresh() {
    sensitivityEl.value = String(settings.sensitivity);
    sensitivityValueEl.textContent = `${settings.sensitivity.toFixed(2)}×`;
    fovEl.value = String(settings.fov);
    fovValueEl.textContent = `${Math.round(settings.fov)}°`;
    shakeEl.checked = settings.screenShake;
    damageNumbersEl.checked = settings.damageNumbers;
  }

  function commit() {
    refresh();
    onChange(settings);
  }

  sensitivityEl.addEventListener("input", () => {
    settings.sensitivity = clampNumber(sensitivityEl.value, DEFAULT_USER_SETTINGS.sensitivity, LIMITS.sensitivity);
    commit();
  });
  fovEl.addEventListener("input", () => {
    settings.fov = clampNumber(fovEl.value, DEFAULT_USER_SETTINGS.fov, LIMITS.fov);
    commit();
  });
  shakeEl.addEventListener("change", () => {
    settings.screenShake = shakeEl.checked;
    commit();
  });
  damageNumbersEl.addEventListener("change", () => {
    settings.damageNumbers = damageNumbersEl.checked;
    commit();
  });
  resetEl.addEventListener("click", () => {
    Object.assign(settings, DEFAULT_USER_SETTINGS);
    commit();
  });

  refresh();
  return { panel, refresh };
}
