/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

function setup() {
  for (let node of document.querySelectorAll("[data-l10n-id]")) {
    node.textContent = browser.i18n.getMessage(node.dataset.l10nId);
  }

  restoreOptions();
}

async function restoreOptions() {
  let prefs = await browser.storage.local.get(["baseURL", "publicURL", "username", "password"]);

  for (let key of Object.keys(prefs)) {
    let elem = document.getElementById(key);
    if (!elem) {
      continue;
    }

    console.log(key, prefs[key]);

    elem.value = prefs[key];
  }

  document.getElementById("publicURL").setAttribute("placeholder", document.getElementById("baseURL").value);
}


function changeOptions(event) {
  let node = event.target;
  if (!node.id || node.localName != "input") {
    return;
  }

  console.log("SET", node.id, node.value);

  browser.storage.local.set({ [node.id]: node.value });

  if (node.id == "baseURL") {
    document.getElementById("publicURL").setAttribute("placeholder", node.value);
  }
}

// https://davidwalsh.name/javascript-debounce-function
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    let later = () => {
      timeout = null;
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    if (!timeout) {
      func.apply(this, args);
    }
  };
}

document.body.addEventListener("change", changeOptions);
document.body.addEventListener("input", debounce(changeOptions, 500));
window.addEventListener("DOMContentLoaded", setup);
