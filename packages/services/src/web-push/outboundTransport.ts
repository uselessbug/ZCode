import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import {
  WebPushValidationError,
  type WebPushOutboundRequest,
  type WebPushOutboundResponse,
  type WebPushSendImpl,
} from "./contract.js";
import {
  isLoopbackHostname,
  resolveAndValidatePushAddresses,
  validatePushEndpoint,
  type WebPushDnsLookup,
} from "./endpointPolicy.js";

export interface CreateSafeWebPushTransportOptions {
  allowLoopbackEndpoint?: boolean;
  lookupImpl?: WebPushDnsLookup;
}

export function createSafeWebPushTransport(
  options: CreateSafeWebPushTransportOptions = {},
): WebPushSendImpl {
  const allowLoopbackEndpoint = options.allowLoopbackEndpoint === true;

  return (outbound: WebPushOutboundRequest): Promise<WebPushOutboundResponse> => {
    const endpointUrl = validatePushEndpoint(outbound.url, { allowLoopbackEndpoint });
    const allowLoopbackForHost = allowLoopbackEndpoint && isLoopbackHostname(endpointUrl.hostname);
    const requestFn = endpointUrl.protocol === "https:" ? httpsRequest : httpRequest;

    const customLookup: LookupFunction = (hostname, opts, callback) => {
      void resolveAndValidatePushAddresses(hostname, {
        allowLoopback: allowLoopbackForHost,
        lookupImpl: options.lookupImpl,
      }).then(
        (addresses: LookupAddress[]) => {
          if (opts.all) {
            callback(null, addresses);
          } else {
            const first = addresses[0]!;
            callback(null, first.address, first.family);
          }
        },
        (error: unknown) => {
          const err = error instanceof Error ? error : new Error(String(error));
          callback(err as NodeJS.ErrnoException, opts.all ? [] : "");
        },
      );
    };

    return new Promise<WebPushOutboundResponse>((resolve, reject) => {
      let settled = false;
      const finishResolve = (result: WebPushOutboundResponse) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const bodyBuffer = Buffer.from(
        outbound.body.buffer,
        outbound.body.byteOffset,
        outbound.body.byteLength,
      );

      const req = requestFn(
        endpointUrl,
        {
          method: "POST",
          headers: {
            ...outbound.headers,
            "Content-Length": String(bodyBuffer.byteLength),
          },
          lookup: customLookup,
          agent: false,
          timeout: outbound.timeoutMs,
          signal: AbortSignal.timeout(outbound.timeoutMs),
        },
        (res) => {
          res.resume();
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            finishReject(
              new WebPushValidationError(`Push endpoint returned disallowed redirect (${status})`),
            );
            return;
          }
          finishResolve({ status });
        },
      );

      req.on("timeout", () => {
        req.destroy(new Error(`Web Push outbound request timed out after ${outbound.timeoutMs}ms`));
      });

      req.on("error", (error) => {
        finishReject(error);
      });

      req.end(bodyBuffer);
    });
  };
}
