import { nanoid } from 'nanoid';
import { IPublishPacket } from 'mqtt';
import mqtt from 'mqtt';
import indexTmpl from './templates/index.html';
import countTmpl from './templates/count.html';
import Sha1 from 'crypto-js/sha1';
import Base64 from 'crypto-js/enc-base64';
import Mustache from 'mustache';

/* Static assets */
import androidChrome192x from './static/android-chrome-192x192.png';
import androidChrome512x from './static/android-chrome-512x512.png';
import favicon from './static/favicon.ico';
import manifestJson from './static/manifest.json';
const manifest = JSON.stringify(manifestJson);

let globalCount: number = 0;

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

class AppController {
  constructor(private request: Request, private env: Env, private ctx: ExecutionContext) {}

  async getRoot(): Promise<Response> {
    const clientInfo = {
      organization: this.request.cf?.asOrganization,
      city: this.request.cf?.city,
      country: this.request.cf?.country,
      postalCode: this.request.cf?.postalCode,
    };

    let originRegion: string = 'unknown';
    try {
      const res = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'OPTIONS',
      });
      originRegion = res.headers.get('cf-ray')!.split('-')[1]; // LHR
    } catch (e) {
      console.error(e);
    }

    const serverInfo = {
      region: originRegion,
    };

    const rendered = Mustache.render(indexTmpl, {
      clientInfo: JSON.stringify(clientInfo, null, 2),
      serverInfo: JSON.stringify(serverInfo, null, 2),
      globalCount,
    });
    return new Response(rendered, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  }

  async getCount(): Promise<Response> {
    globalCount += 1;
    const rendered = Mustache.render(countTmpl, {
      globalCount,
    });
    return new Response(rendered, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  }

  async getWs(): Promise<Response> {
    if (this.request.headers.get('Upgrade') !== 'websocket') return new Response('400 - Expected websocket', { status: 400 });

    try {
      const hash = Sha1(this.request.headers.get('CF-Connecting-IP')!);
      this.env.username = Base64.stringify(hash).slice(1, 8);
    } catch (e) {
      console.error(e);
      throw e;
    }

    const [client, server] = Object.values(new WebSocketPair());
    await new WebSocketController(this.env, this.ctx, server).handle();

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async get404(): Promise<Response> {
    return new Response('404 - Not Found', { status: 404 });
  }

  async get405(): Promise<Response> {
    return new Response('405 - Method Not Allowed', { status: 405 });
  }

  async serveFile(data: ArrayBuffer, mime: string): Promise<Response> {
    const oneWeekInSeconds = 7 * 24 * 60 * 60; // 1 week in seconds
    const expirationDate = new Date(Date.now() + oneWeekInSeconds * 1000).toUTCString();

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': `public, max-age=${oneWeekInSeconds}`,
        Expires: expirationDate,
      },
    });
  }

  async serveJson(data: string, mime: string): Promise<Response> {
    const oneWeekInSeconds = 7 * 24 * 60 * 60; // 1 week in seconds
    const expirationDate = new Date(Date.now() + oneWeekInSeconds * 1000).toUTCString();

    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${oneWeekInSeconds}`,
        Expires: expirationDate,
      },
    });
  }

  handle(): Promise<Response> {
    const url = new URL(this.request.url);

    switch (url.pathname) {
      case '':
      case '/':
        if (!['GET', 'HEAD'].includes(this.request.method)) return this.get405();
        return this.getRoot();
      case '/count':
        if (!['GET', 'HEAD'].includes(this.request.method)) return this.get405();
        return this.getCount();
      case '/ws':
        return this.getWs();
      case '/manifest.json':
        return this.serveJson(manifest, 'application/json');
      case '/android-chrome-192x192.png':
        return this.serveFile(androidChrome192x, 'image/png');
      case '/android-chrome-512x512.png':
        return this.serveFile(androidChrome512x, 'image/png');
      case '/favicon.ico':
        return this.serveFile(favicon, 'image/x-icon');
      default:
        if (!['GET', 'HEAD'].includes(this.request.method)) return this.get405();
        return this.get404();
    }
  }
}

interface ClientMessageDTO {
  type: 'message';
  message?: string;
}

interface ClientPingDTO {
  type: 'ping';
}

interface MqttMessageDTO {
  username: string;
  message: string;
}

class WebSocketController {
  private mqttService: MqttService;
  private mqttCallbackCleanup!: () => void;
  constructor(private env: Env, private ctx: ExecutionContext, private websocket: WebSocket) {
    this.mqttService = new MqttService(env, ctx);
  }

  async handle() {
    // "open"-event is not fired, no listener defined.
    this.websocket.addEventListener('error', this.onError.bind(this));
    this.websocket.addEventListener('close', this.onClose.bind(this));
    this.websocket.addEventListener('message', this.onMessage.bind(this));
    this.mqttCallbackCleanup = this.mqttService.addCallback(this.onMqttMessage.bind(this));

    this.websocket.accept();
  }

  async onMessage(ev: MessageEvent) {
    if (typeof ev.data !== 'string') {
      console.debug('received invalid binary packet, closing connection');
      this.websocket.close();
      return;
    }

    let data: ClientMessageDTO | ClientPingDTO | null = null;

    try {
      data = JSON.parse(ev.data);

      if (data?.type == 'ping') {
        this.websocket.send(''); // Pong
        return;
      } else if (data?.type !== 'message') {
        throw Error('invalid json');
      }
    } catch (e) {
      console.warn('failed to parse WebSocket msg, closing: %s', e);
      this.websocket.close();
      return;
    }

    console.debug('onMessage: %s', data);
    const mqttMsg = {
      username: this.env.username || 'default',
      message: data.message!,
    } satisfies MqttMessageDTO;
    await this.mqttService.sendMessage(mqttMsg);
  }

  async onMqttMessage(msg_: unknown) {
    const msg = msg_ as MqttMessageDTO;
    this.websocket.send(`<div id=chat_room hx-swap-oob="afterbegin"> <li>${msg.username}: ${msg.message}</li> </div>`);
  }

  async onError(ev: ErrorEvent) {
    console.debug('onError: %O', ev);
  }

  async onClose(ev: CloseEvent) {
    console.debug('WebSocket client disconnected');
    this.mqttCallbackCleanup();
  }
}

class MqttService {
  private static DEFAULT_CHAN = 'chat/default';
  private client: mqtt.MqttClient;
  private utf8Decoder = new TextDecoder('UTF-8', { ignoreBOM: true, fatal: true });
  private callbacks: Map<string, (msg: unknown) => void> = new Map();

  constructor(private env: Env, private ctx: ExecutionContext) {
    // Try-catch because of a bug in Cloudflare workers
    try {
      console.debug('Connecting to MQTT...');
      this.client = mqtt.connect(env.MQTT_URL, {
        username: env.MQTT_USER,
        password: env.MQTT_PASS,
      });
      this.client.on('connect', this.onConnect.bind(this));
      this.client.on('disconnect', this.onDisconnect.bind(this));
      this.client.on('message', this.onMessage.bind(this));
    } catch (e) {
      console.error(e);
      throw e;
    }
  }

  private onConnect() {
    console.debug('Connected to MQTT');
    this.client.subscribe(MqttService.DEFAULT_CHAN, (err) => {
      if (err != null) console.error("Failed to subscribe to 'chat': %s", err.message);
    });
  }

  private onDisconnect() {
    console.debug('Disconnected from MQTT');
  }

  private onMessage(topic: string, payload: Buffer, packet: IPublishPacket) {
    const msg = this.utf8Decoder.decode(payload);
    const msgData = JSON.parse(msg) as unknown;

    switch (topic) {
      case MqttService.DEFAULT_CHAN:
        this.callbacks.forEach((v) => v(msgData));
        return;
      default:
        console.warn("Unknown msg from '%s'", topic);
    }
  }

  addCallback(l: (msg: unknown) => void) {
    const id = nanoid();
    this.callbacks.set(id, l);

    // Return cleanup function
    return () => {
      this.callbacks.delete(id);
    };
  }

  async sendMessage(msg: any) {
    await this.client.publishAsync(MqttService.DEFAULT_CHAN, JSON.stringify(msg));
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return new AppController(request, env, ctx).handle();
  },
} satisfies ExportedHandler<Env>;
