/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals browser */

const PROPFIND_QUOTA = `
<propfind xmlns="DAV:">
  <prop>
    <quota-available-bytes/>
    <quota-used-bytes/>
  </prop>
</propfind>
`.trim();

const PROPFIND_RESTYPE =`
<propfind xmlns="DAV:">
  <prop>
    <resourcetype/>
  </prop>
</propfind>
`;

var abortControllers = new Map();
var uploadedFiles = new Map();

async function updateQuota(accountId) {
  let { baseURL, username, password } = await browser.storage.local.get(["baseURL", "username", "password"]);

  let response = await fetchAuth(baseURL, {
    method: "PROPFIND",
    credentials: "include",
    headers: {
      "Content-Type": "application/xml",
      "Depth": 0
    },
    body: PROPFIND_QUOTA,
    username: username,
    password: password
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
  let { username, password } = await browser.storage.local.get(["username", "password"]);

  let response = await fetchAuth(url, {
    method: "PROPFIND",
    credentials: "include",
    headers: {
      "Content-Type": "application/xml",
      "Depth": 0
    },
    body: PROPFIND_RESTYPE,
    username: username,
    password: password
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
  let { baseURL, publicURL, username, password } = await browser.storage.local.get(["baseURL", "publicURL", "username", "password"]);

  let targetURL = new URL(baseURL, name);
  let publicTargetURL = new URL(publicURL || baseURL, name);

  let controller = new AbortController();
  abortControllers.set(id, controller);

  try {
    let response = await fetchAuth(targetURL, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      credentials: "include",
      data: data,
      signal: controller.signal,
      username: username,
      password: password
    });

    if (response.status == 507) {
      throw new DOMException("Quota Exceeded", "QuotaExceededError");
    } else if (!response.ok) {
      throw new Error(`Could not upload file, HTTP ${response.status}: ${response.statusText}`);
    }

    uploadedFiles.set(account + "#" + id, targetURL);

    return { url: publicTargetURL, aborted: controller.signal.aborted };
  } finally {
    abortControllers.delete(id);
  }
});

browser.cloudFile.onFileDeleted.addListener(async (account, fileId) => {
  let { username, password } = await browser.storage.local.get(["username", "password"]);

  let fileKey = account + "#" + fileId;
  if (!uploadedFiles.has(fileKey)) {
    return;
  }

  let response = await fetchAuth(uploadedFiles.get(fileKey), {
    method: "DELETE",
    credentials: "include",
    username: username,
    password: password
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


async function fetchAuth(url, options) {
  let resp = await fetch(url, options);
  if (resp.status == 401 && options.username && options.password) {
    let wwwauth = resp.headers.get("WWW-Authenticate");
    if (wwwauth) {
      console.log("GOT HEADER!!", wwwauth);
    } else {
      // We don't get this header for some reason. We can only assume basic auth then because we
      // don't have access to the realm anyway.
      options.headers = options.headers || {};
      options.headers.Authorization = "Basic " + btoa(`${options.username}:${options.password}`);
      resp = await fetch(url, options);
    }
  }

  return resp;
}
