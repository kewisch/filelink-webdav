/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 * Portions Copyright (C) Philipp Kewisch, 2019 */

import md5 from './md5.js'

export class FetchSession {
  constructor() {
    this.originData = new Map();
  }

  async hash(algorithm, data) {
    function toHex(arr) {
      return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    switch (algorithm) {
      case "SHA-1":
      case "SHA-256":
      case "SHA-384":
      case "SHA-512": {
        let encoder = new TextEncoder();
        let encoded = encoder.encode(data);

        let buf = await crypto.subtle.digest(algorithm, encoded);
        return toHex(new Uint8Array(buf));
      }
      break;
      case "MD5":
      default:
        return md5(data);
    }
  }

  createBasicAuth(options) {
    return "Basic " + btoa(`${options.auth.username}:${options.auth.password}`);
  }

  quote(str) {
    return `"${(str || "").replace(/"/g, '\\"')}"`;
  }

  async createDigestAuth(url, options) {
    let { method = "GET", body = "", auth } = options;
    let originData = this.getOriginData(url, options);
   
    let algorithm = (originData.challenge.algorithm || "MD5").replace(/-sess/i, "");
    let cnonce = await this.hash(algorithm, Math.random().toString(36));
    let urlobj = new URL(url);
    
    let user = auth.username || originData.username;

    if (originData.challenge.userhash == "true") {
      user = await this.hash(algorithm, `${user}:${originData.challenge.realm}`);
    }

    let a1 = `${user}:${originData.challenge.realm}:${auth.password}`;
    let a2 = `${method}:${urlobj.pathname}`;
    
    let qop = null;
    let qopAvailable = originData.challenge.qop.split(/,\s*/);
    
    if (qopAvailable.includes("auth-int")) {
      let hbody = await this.hash(algorithm, body);
      a2 = `${method}:${urlobj.pathname}:${hbody}`;
      qop = "auth-int";
    } else if (qopAvailable.includes("auth")) {
      qop = "auth";
    }
    

    let ha1 = await this.hash(algorithm, a1);
    let ha2 = await this.hash(algorithm, a2);
    
    if (originData.challenge.nonce == this.lastNonce) {
      originData.nc++;
    } else {
      originData.nc = 1;
    }
    this.lastNonce = originData.challenge.nonce;
    
    if (originData.challenge.algorithm.toLowerCase().endsWith("-sess")) {
      console.log("session algo");
      ha1 = await this.hash(algorithm, `${ha1}:${originData.challenge.nonce}:${cnonce}`);
    }
    
    let KD = async (s, d) => this.hash(algorithm, `${s}:${d}`);
    let ncpad = originData.nc.toString().padStart(8, "0");
    
    let response;
    if (!qop) {
      // rfc 2069 style response
      response = await KD(ha1, `${originData.challenge.nonce}:${ha2}`);
    } else {
      // rfc 7616 style response
      response = await KD(ha1, `${originData.challenge.nonce}:${ncpad}:${cnonce}:${qop}:${ha2}`);
    }

    return `Digest response=${this.quote(response)},username=${this.quote(user)},` +
           `realm=${this.quote(originData.challenge.realm)},uri=${this.quote(urlobj.pathname)},qop=${qop},` +
           `cnonce=${this.quote(cnonce)},nc=${ncpad},userhash=${originData.challenge.userhash || "false"},` +
           `opaque=${this.quote(originData.challenge.opaque)},algorithm=${originData.challenge.algorithm},` +
           `nonce=${this.quote(originData.challenge.nonce)}`;
           
  }

  parseWWWAuth(input) {
    function consumeRE(regex) {
      let token = input.match(regex);
      if (token) {
        input = input.substr(token[0].length);
        return token;
      }
      return null;
    }

    const RE_SCHEME = /^([!#$%&'*+.^_`|~0-9a-zA-Z\x21-x7E-]+)\s+/;
    const RE_AUTH_PARAM = /(,?([!#$%&'*+.^_`|~0-9a-zA-Z\x21-\x3C\x3E-x7E-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[!#$%&'*+.^_`|~0-9a-zA-Z\x21-\x2B\x2D-x7E-]+))/;

    let scheme = null;
    let params = {};

    let schemeres = consumeRE(RE_SCHEME);
    if (schemeres && schemeres[1]) {
      scheme = schemeres[1];

      for (let param = consumeRE(RE_AUTH_PARAM); param; param = consumeRE(RE_AUTH_PARAM)) {
        params[param[2]] = param[4] || param[3];
      }
    }

    return { scheme, params };
  }

  getOriginData(url, options) {
    let urlObj = new URL(url);
    return this.originData.get(urlObj.origin) || {};
  }

  setOriginData(url, options, originData) {
    this.originData.set(new URL(url).origin, originData);
  }
  
  async addAuthentication(url, options) {
    let { authScheme } = this.getOriginData(url, options);

    if (authScheme == "Digest") {
      options.headers.Authorization = await this.createDigestAuth(url, options);
      console.log(options.headers.Authorization);
    } else if (authScheme == "Basic") {
      options.headers.Authorization = this.createBasicAuth(options);
    } else {
      return false;
    }
    return true;
  }
  
  async prompter(url, options, authHdr) {
    return options;
  }

  async fetch(url, options) {
    options.headers = options.headers || {};
    await this.addAuthentication(url, options);

    let resp = await fetch(url, options);
    if (resp.status == 401) {
      let wwwauth = resp.headers.get("WWW-Authenticate");
      if (wwwauth) {
        console.log(wwwauth);
        let authHdr = this.parseWWWAuth(wwwauth);
        authHdr.prevFailed = !!options.headers.Authorization;
        
        if (!authHdr.params.stale || authHdr.params.stale.toLowerCase() != "true") {
          options = await this.prompter(url, options, authHdr);
        }
        
        if (options.auth.username && options.auth.password) {
          let originData = {
            authScheme: authHdr.scheme,
            challenge: authHdr.params,
            username: options.auth.username,
            nc: 1
          };

          this.setOriginData(url, options, originData);

          if (await this.addAuthentication(url, options)) {
            resp = await fetch(url, options);
          }
        }
      }
    }

    return resp;
  }
}


let gFetchSession = new FetchSession();


export function fetchAuth(url, options) {
  return gFetchSession.fetch(url, options);
}
