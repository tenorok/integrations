import * as Promise from "bluebird";
import broidSchemas from "broid-schemas";
import { Logger } from "broid-utils";
import { EventEmitter } from "events";
import { Router } from "express";
import * as uuid from "node-uuid";
import * as R from "ramda";
import { Observable } from "rxjs/Rx";
import * as twilio from "twilio";

import { IAdapterOptions, ITwilioWebHookEvent } from "./interfaces";
import Parser from "./parser";
import WebHookServer from "./webHookServer";

export default class Adapter {
  private serviceID: string;
  private token: string | null;
  private tokenSecret: string | null;
  private connected: boolean;
  private session: any;
  private parser: Parser;
  private logLevel: string;
  private username: string;
  private logger: Logger;
  private emitter: EventEmitter;
  private router: Router;
  private webhookServer: WebHookServer;

  constructor(obj: IAdapterOptions) {
    this.serviceID = obj && obj.serviceID || uuid.v4();
    this.logLevel = obj && obj.logLevel || "info";
    this.token = obj && obj.token || null;
    this.tokenSecret = obj && obj.tokenSecret || null;
    this.username = obj && obj.username || "SMS";

    this.parser = new Parser(this.serviceID, this.logLevel);
    this.logger = new Logger("adapter", this.logLevel);
    this.emitter = new EventEmitter();
    this.router = this.setupRouter();

    if (obj.http) {
      this.webhookServer = new WebHookServer(obj.http, this.router, this.logLevel);
    }
  }

  // Return list of users information
  public users(): Promise {
    return Promise.reject(new Error("Not supported"));
  }

  // Return list of channels information
  public channels(): Promise {
    return Promise.reject(new Error("Not supported"));
  }

  // Return the service ID of the current instance
  public serviceId(): String {
    return this.serviceID;
  }

  public getRouter(): Router {
    return this.router;
  }

  // Connect to Twilio
  // Start the webhook server
  public connect(): Observable<Object> {
    if (this.connected) {
      return Observable.of({ type: "connected", serviceID: this.serviceId() });
    }
    this.connected = true;

    if (!this.token
      || !this.tokenSecret) {
      return Observable.throw(new Error("Credentials should exist."));
    }

    this.session = new twilio.RestClient(this.token, this.tokenSecret);
    if (this.webhookServer) {
      this.webhookServer.listen();
    }

    return Observable.of({ type: "connected", serviceID: this.serviceId() });
  }

  public disconnect(): Promise<null> {
    this.connected = false;
    if (this.webhookServer) {
      return this.webhookServer.close();
    }

    return Promise.resolve(null);
  }

  // Listen "message" event from Twilio
  public listen(): Observable<Object> {
    if (!this.session) {
      return Observable.throw(new Error("No session found."));
    }

    return Observable.fromEvent(this.emitter, "message")
      .mergeMap((event: ITwilioWebHookEvent) => this.parser.normalize(event))
      .mergeMap((normalized) => this.parser.parse(normalized))
      .mergeMap((parsed) => this.parser.validate(parsed))
      .mergeMap((validated) => {
        if (!validated) { return Observable.empty(); }
        return Promise.resolve(validated);
      });
  }

  public send(data: Object): Promise {
    this.logger.debug("sending", { message: data });
    return broidSchemas(data, "send")
      .then(() => {
        const toNumber: string = R.path(["to", "id"], data)
          || R.path(["to", "name"], data);
        const type: string = R.path(["object", "type"], data);
        let content: string = R.path(["object", "content"], data)
          || R.path(["object", "name"], data);

        if (type === "Image" || type === "Video") {
          content = R.path(["object", "url"], data) || R.path(["object", "content"], data)
            || R.path(["object", "name"], data);
        }

        if (type === "Note" || type === "Image" || type === "Video") {
          const sms = {
            body: content,
            from: this.username,
            to: toNumber,
          };

          return new Promise((resolve, reject) => {
            return this.session.messages.create(sms, (err) => {
              if (err) { return reject(err); }
              return resolve({ type: "sent", serviceID: this.serviceId() });
            });
          });
        }

        return Promise.reject(new Error("Only Note, Image, and Video are supported."));
      });
  }

  private setupRouter(): Router {
    const router = Router();
    // placeholder route handler
    router.post("/", (req, res) => {
      const event: ITwilioWebHookEvent = {
        request: req,
        response: res,
      };

      this.emitter.emit("message", event);

      const twiml = new twilio.TwimlResponse();
      res.type("text/xml");
      res.send(twiml.toString());
    });

    return router;
  }
}
