import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import axios, { AxiosResponse } from "axios";
import bs58 from "bs58";

// Required for @noble/ed25519 v1.7.x in Node.js
ed.utils.sha512Sync = (msg: Uint8Array) => sha512(msg);

const BASE_URL = "https://api.orderly.org";

export class OrderlySigner {
  private accountId: string;
  private privateKeyBytes: Uint8Array;
  private publicKeyB58: string;

  constructor(accountId: string, secretB58: string, publicKey: string) {
    this.accountId = accountId;

    // Strip optional "ed25519:" prefix from both keys
    const cleanSecret = secretB58.startsWith("ed25519:") ? secretB58.slice(8) : secretB58;
    const cleanPublic = publicKey.startsWith("ed25519:") ? publicKey.slice(8) : publicKey;

    this.privateKeyBytes = bs58.decode(cleanSecret);
    this.publicKeyB58 = "ed25519:" + cleanPublic;
  }

  private timestamp(): number {
    return Date.now();
  }

  private normalize(ts: number, method: string, path: string, body?: object): string {
    let msg = `${ts}${method.toUpperCase()}${path}`;
    if (body) msg += JSON.stringify(body);
    return msg;
  }

  private async sign(message: string): Promise<string> {
    const msgBytes = new TextEncoder().encode(message);
    const sigBytes = await ed.sign(msgBytes, this.privateKeyBytes);
    return Buffer.from(sigBytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  async request(
    method: string,
    path: string,
    params?: Record<string, string | number>,
    body?: object
  ): Promise<any> {
    const ts = this.timestamp();
    method = method.toUpperCase();

    let fullPath = path;
    if (params && Object.keys(params).length > 0) {
      const qs = Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      fullPath = `${path}?${qs}`;
    }

    const msg = this.normalize(ts, method, fullPath, body);
    const signature = await this.sign(msg);

    const headers: Record<string, string> = {
      "Content-Type": method === "GET" || method === "DELETE"
        ? "application/x-www-form-urlencoded"
        : "application/json",
      "orderly-account-id": this.accountId,
      "orderly-key": this.publicKeyB58,
      "orderly-signature": signature,
      "orderly-timestamp": String(ts),
    };

    const url = `${BASE_URL}${fullPath}`;

    let response: AxiosResponse;
    if (method === "GET") {
      response = await axios.get(url, { headers });
    } else if (method === "POST") {
      response = await axios.post(url, body, { headers });
    } else if (method === "PUT") {
      response = await axios.put(url, body, { headers });
    } else if (method === "DELETE") {
      response = await axios.delete(url, { headers });
    } else {
      throw new Error(`Unsupported method: ${method}`);
    }

    return response.data;
  }
}