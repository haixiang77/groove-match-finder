// @ts-check
import { APP_VERSION } from '../version.js';

/**
 * @param {string} appVersion
 * @param {number} analysisVersion
 * @returns {string}
 */
export function formatVersionLabel(appVersion, analysisVersion) {
  return `RefScope v${appVersion}（解析バージョン ${analysisVersion}）`;
}

/**
 * Fill the footer version element via textContent.
 * @param {number} analysisVersion
 * @param {string} [id]
 */
export function renderVersion(analysisVersion, id = 'app-version') {
  const el = document.getElementById(id);
  if (el) el.textContent = formatVersionLabel(APP_VERSION, analysisVersion);
}
