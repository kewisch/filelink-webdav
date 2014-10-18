/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2012 */

function extraArgs() {
  var baseURL = document.getElementById("baseURL").value.trim();
  if (baseURL[baseURL.length - 1] != '/') {
    baseURL += "/";
  }
  return {
    "baseURL": { type: "char", value: baseURL },
  };  
}
