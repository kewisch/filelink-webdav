/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals browser */

import { fetchAuth } from './fetchAuth.js'

const PROPFIND_QUOTA = `
<propfind xmlns="DAV:">
  <prop>
    <quota-available-bytes/>
    <quota-used-bytes/>
  </prop>
</propfind>
`.trim();

const PROPFIND_RESTYPE = `
<propfind xmlns="DAV:">
  <prop>
    <resourcetype/>
  </prop>
</propfind>
`.trim();

const RE_TOKEN = /^[!#$%&'*+.^_`|~0-9a-zA-Z\x21-x7E-]+/;
const RE_TOKEN68 = /^[A-Za-z0-9._~+/-]+/;
const RE_1SP = /^\s+/;
const RE_OBWS = /^\s*/;
const RE_EQ = /^=/;
const RE_QUOTED_STRING = /^"(?:[^"\\]|\\.)*"/

var abortControllers = new Map();
var uploadedFiles = new Map();

async function updateQuota(accountId) {
  let { baseURL, username, password } = await browser.storage.local.get(["baseURL", "username", "password"]);

  let response = await fetchAuth(baseURL, {
    method: "PROPFIND",
    auth: { username, password },
    headers: {
      "Content-Type": "application/xml",
      "Depth": 0
    },
    body: PROPFIND_QUOTA
  });

  if (!response.ok) {
    return;
  }

  let parser = new DOMParser();
  let doc = parser.parseFromString(await response.text(), "application/xml");

  let qub = doc.getElementsByTagNameNS("DAV:", "quota-used-bytes");
  let qab = doc.getElementsByTagNameNS("DAV:", "quota-available-bytes");

  let spaceUsed = qub.length ? Math.max(-1, parseInt(qub[0].textContent || -1, 10)) : -1;
  let spaceRemaining = qab.length ? Math.max(-1, parseInt(qab[0].textContent || -1, 10)) : -1;

  await browser.cloudFile.updateAccount(accountId, { spaceUsed, spaceRemaining });
}

async function detectRestype(url) {
  let auth = await browser.storage.local.get(["username", "password"]);

  let response = await fetchAuth(url, {
    method: "PROPFIND",
    auth: auth,
    headers: {
      "Content-Type": "application/xml",
      "Depth": 0
    },
    body: PROPFIND_RESTYPE
  });

  if (!response.ok) {
    return null;
  }

  let parser = new DOMParser();
  let doc = parser.parseFromString(await response.text(), "application/xml");

  let restype = doc.getElementsByTagNameNS("DAV:", "resourcetype");
  if (restype.length && restype[0].getElementsByTagNameNS("DAV:", "collection")) {
    return "collection";
  } else {
    return restype[0].firstElementChild.localname || "unknown";
  }
}

browser.cloudFile.onFileUpload.addListener(async (account, { id, name, data }) => {
  let prefs = await browser.storage.local.get({
    baseURL: "",
    publicURL: "",
    checkOverwrite: true,
    username: "",
    password: ""
  });

  let targetURL = new URL(name, prefs.baseURL);
  let publicTargetURL = new URL(name, prefs.publicURL || prefs.baseURL);

  let controller = new AbortController();
  abortControllers.set(id, controller);

  let headers = {
    "Content-Type": "application/octet-stream",
    "Origin": targetURL.origin
  };

  if (prefs.checkOverwrite) {
    headers["If-None-Match"] = "*";
  }

  try {
    let response = await fetchAuth(targetURL.href, {
      method: "PUT",
      headers: headers,
      auth: { username: prefs.username, password: prefs.password },
      body: data,
      signal: controller.signal
    });

    if (response.status == 507) {
      throw new DOMException("Quota Exceeded", "QuotaExceededError");
    } else if (response.status == 412) {
      throw new DOMException("File already exists", "ConstraintError");
    } else if (!response.ok) {
      throw new Error(`Could not upload file, HTTP ${response.status}: ${response.statusText}`);
    }

    uploadedFiles.set(account + "#" + id, targetURL.href);

    return { url: publicTargetURL.href, aborted: controller.signal.aborted };
  } finally {
    abortControllers.delete(id);
  }
});

browser.cloudFile.onFileDeleted.addListener(async (account, fileId) => {
  let auth = await browser.storage.local.get(["username", "password"]);

  let fileKey = account + "#" + fileId;
  if (!uploadedFiles.has(fileKey)) {
    return;
  }

  let response = await fetchAuth(uploadedFiles.get(fileKey), {
    method: "DELETE",
    auth: auth
  });

  if (response.ok) {
    uploadedFiles.delete(fileKey);
  }
});

browser.cloudFile.onFileUploadAbort.addListener((account, id) => {
  let controller = abortControllers.get(id);
  if (controller) {
    controller.abort();
  }
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.action == "updateQuota") {
    return updateQuota(message.accountId);
  } else if (message.action == "getResourceType") {
    return detectRestype(message.url);
  }
  return null;
});


(async function() {
  if (!browser.webdavlegacy || browser.webdavlegacy.migrated) {
    return;
  }

  let accounts = browser.webdavlegacy.getAccounts();
  for (let account of accounts) {
    await browser.storage.local.set({
      [`accounts.${account.key}.baseURL`]: account.baseURL,
      [`accounts.${account.key}.publicURL`]: account.publicURL
    });
  }

  browser.webdavlegacy.purge();
})();
