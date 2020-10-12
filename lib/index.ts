import http from "http";
import {existsSync as exists, readFileSync as read} from "fs";
import path from "path";
import engine from "engine.io";
import {Client} from "./client";
import {EventEmitter} from "events";
import {Namespace} from "./namespace";
import {ParentNamespace} from "./parent-namespace";
import {Adapter} from "socket.io-adapter";
import * as parser from "socket.io-parser";
import {Encoder, PacketType} from "socket.io-parser";
import url from "url";
import debugModule from "debug";
import {Socket} from "./socket";
import {CookieSerializeOptions} from "cookie";
import {CorsOptions} from "cors";

const debug = debugModule("socket.io:server");

const clientVersion = require("socket.io-client/package.json").version;

/**
 * Socket.IO client source.
 */

let clientSource = undefined; // 客户端源码内容
let clientSourceMap = undefined; // 客户端源码内容映射

type Transport = "polling" | "websocket";

interface EngineOptions {
    /**
     * how many ms without a pong packet to consider the connection closed (5000)
     */
    pingTimeout: number;
    /**
     * how many ms before sending a new ping packet (25000)
     */
    pingInterval: number;
    /**
     * how many ms before an uncompleted transport upgrade is cancelled (10000)
     */
    upgradeTimeout: number;
    /**
     * how many bytes or characters a message can be, before closing the session (to avoid DoS). Default value is 1E5.连接能发送最多字节数
     */
    maxHttpBufferSize: number;
    /**
     * A function that receives a given handshake or upgrade request as its first parameter,
     * and can decide whether to continue or not. The second argument is a function that needs
     * to be called with the decided information: fn(err, success), where success is a boolean
     * value where false means that the request is rejected, and err is an error code.
     */
    allowRequest: (
        req: http.IncomingMessage,
        fn: (err: string | null | undefined, success: boolean) => void
    ) => void;
    /**
     * to allow connections to (['polling', 'websocket'])
     */
    transports: Transport[];
    /**
     * whether to allow transport upgrades (true)
     */
    allowUpgrades: boolean;
    /**
     * parameters of the WebSocket permessage-deflate extension (see ws module api docs). Set to false to disable. (false)
     * 客户端和服务端之间就是根据首次http请求中的Sec-WebSocket-Extensions这个头域中的permessage-deflate这个参数来协商是否对传输数据进行deflate压缩的
     */
    perMessageDeflate: boolean | object;
    /**
     * parameters of the http compression for the polling transports (see zlib api docs). Set to false to disable. (true)
     */
    httpCompression: boolean | object;
    /**
     * what WebSocket server implementation to use. Specified module must
     * conform to the ws interface (see ws module api docs). Default value is ws.
     * An alternative c++ addon is also available by installing uws module.
     * webSocket引擎实现
     */
    wsEngine: string;
    /**
     * an optional packet which will be concatenated to the handshake packet emitted by Engine.IO.
     */
    initialPacket: any;
    /**
     * configuration of the cookie that contains the client sid to send as part of handshake response headers. This cookie
     * might be used for sticky-session. Defaults to not sending any cookie (false)
     */
    cookie: CookieSerializeOptions | boolean;
    /**
     * the options that will be forwarded to the cors module
     */
    cors: CorsOptions;
}

interface AttachOptions {
    /**
     * name of the path to capture (/engine.io).
     */
    path: string;
    /**
     * destroy unhandled upgrade requests (true)
     */
    destroyUpgrade: boolean;
    /**
     * milliseconds after which unhandled requests are ended (1000)
     */
    destroyUpgradeTimeout: number;
}

interface EngineAttachOptions extends EngineOptions, AttachOptions {
}

export interface ServerOptions extends EngineAttachOptions {
    /**
     * name of the path to capture (/socket.io)
     */
    path: string;
    /**
     * whether to serve the client files (true)
     */
    serveClient: boolean;
    /**
     * the adapter to use. Defaults to an instance of the Adapter that ships with socket.io which is memory based.
     */
    adapter: any;
    /**
     * the allowed origins (*:*)
     */
    origins: string | string[];
    /**
     * the parser to use. Defaults to an instance of the Parser that ships with socket.io.
     */
    parser: any;
}

class Server extends EventEmitter {
    // 默认命名空间别名，这样命名是因为一个命名空间可能有多个Socket连接
    public readonly sockets: Namespace;

    /** @package */
    public readonly parser; // 解析器
    /** @package */
    public readonly encoder: Encoder; // 编码器

    // 保存名称与命名空间对象映射关系，包含所有具体名称和命名空间对象的映射关系
    private nsps: Map<string, Namespace> = new Map();
    // 保存名称与父命名空间映射关系，包含是函数与命名空间对象映射关系
    private parentNsps: Map<| string
        | RegExp
        | ((
        name: string,
        query: object,
        fn: (err: Error, success: boolean) => void
    ) => void),
        ParentNamespace> = new Map();
    private _adapter; // 适配器
    private _origins; // 跨域设置
    private _serveClient: boolean; // 是否提供客户端脚本服务
    private eio; // 底层引擎，engine.io对象实例
    private engine; // engine.io对象实例
    private _path: string; // 服务路径
    private httpServer: http.Server; // http服务器

    /**
     * Server constructor.
     *
     * @param {http.Server|Number|Object} srv http server, port or options
     * @param {Object} [opts]
     */
    constructor(opts?: Partial<ServerOptions>);
    constructor(srv: http.Server, opts?: Partial<ServerOptions>);
    constructor(srv: number, opts?: Partial<ServerOptions>);
    constructor(srv?: any, opts: Partial<ServerOptions> = {}) {
        super();
        if ("object" == typeof srv && srv instanceof Object && !srv.listen) {
            opts = srv;
            srv = null;
        }
        this.path(opts.path || "/socket.io");
        this.serveClient(false !== opts.serveClient);
        this.parser = opts.parser || parser;
        this.encoder = new this.parser.Encoder();
        this.adapter(opts.adapter || Adapter);
        this.origins(opts.origins || "*:*");
        this.sockets = this.of("/"); // 创建默认命名空间对象
        if (srv) this.attach(srv, opts); // 如果直接传入http服务器对象
    }

    /**
     * Server request verification function, that checks for allowed origins
     * 检查允许的源
     *
     * @param {http.IncomingMessage} req request
     * @param {Function} fn callback to be called with the result: `fn(err, success)`
     */
    private checkRequest(
        req: http.IncomingMessage,
        fn: (err: Error, success: boolean) => void
    ) {
        // 获取请求源
        let origin = req.headers.origin || req.headers.referer;

        // file:// URLs produce a null Origin which can't be authorized via echo-back
        if ("null" == origin || null == origin) origin = "*";

        if (!!origin && typeof this._origins == "function")
            return this._origins(origin, fn);
        if (this._origins.indexOf("*:*") !== -1) return fn(null, true);
        if (origin) {
            try {
                const parts: any = url.parse(origin);
                const defaultPort = "https:" == parts.protocol ? 443 : 80;
                parts.port = parts.port != null ? parts.port : defaultPort;
                const ok =
                    ~this._origins.indexOf(
                        parts.protocol + "//" + parts.hostname + ":" + parts.port
                    ) ||
                    ~this._origins.indexOf(parts.hostname + ":" + parts.port) ||
                    ~this._origins.indexOf(parts.hostname + ":*") ||
                    ~this._origins.indexOf("*:" + parts.port);
                debug("origin %s is %svalid", origin, !!ok ? "" : "not ");
                return fn(null, !!ok);
            } catch (ex) {
            }
        }
        fn(null, false);
    }

    /**
     * Sets/gets whether client code is being served.
     * 返回客户端源码
     *
     * @param {Boolean} v - whether to serve client code
     * @return {Server|Boolean} self when setting or value when getting
     */
    public serveClient(v?: boolean) {
        if (!arguments.length) return this._serveClient;
        this._serveClient = v;
        const resolvePath = function (file) {
            const filepath = path.resolve(__dirname, "./../../", file);
            if (exists(filepath)) {
                return filepath;
            }
            return require.resolve(file);
        };
        if (v && !clientSource) {
            clientSource = read(
                resolvePath("socket.io-client/dist/socket.io.js"),
                "utf-8"
            );
            try {
                clientSourceMap = read(
                    resolvePath("socket.io-client/dist/socket.io.js.map"),
                    "utf-8"
                );
            } catch (err) {
                debug("could not load sourcemap file");
            }
        }
        return this;
    }

    /**
     * Executes the middleware for an incoming namespace not already created on the server.
     * 为服务器上尚未创建的名称空间执行中间件。这里是检查动态命名空间，找到匹配动态命名空间并创建其子命名空间
     *
     * @param {String} name - name of incoming namespace
     * @param {Object} query - the query parameters
     * @param {Function} fn - callback
     *
     * @package
     */
    public checkNamespace(
        name: string,
        query: object,
        fn: (nsp: Namespace | boolean) => void
    ) {
        // 如果不存在动态命名空间，则直接返回错误包
        if (this.parentNsps.size === 0) return fn(false);

        // 如果存在动态命名空间，则遍历
        const keysIterator = this.parentNsps.keys();

        const run = () => {
            let nextFn = keysIterator.next();
            if (nextFn.done) { // 如果遍历完成都没有找到匹配的，则直接返回错误包
                return fn(false);
            }
            nextFn.value(name, query, (err, allow) => {
                if (err || !allow) {
                    run(); // 递归调用
                } else { // 如果找到匹配的，则获取该命名空间对象，然后创建其子命名空间
                    fn(this.parentNsps.get(nextFn.value).createChild(name));
                }
            });
        };

        run();
    }

    /**
     * Sets the client serving path.设置客户端服务路径
     *
     * @param {String} v pathname
     * @return {Server|String} self when setting or value when getting
     */
    public path(v?: string) {
        if (!arguments.length) return this._path;
        this._path = v.replace(/\/$/, "");
        return this;
    }

    /**
     * Sets the adapter for rooms.设置房间适配器
     *
     * @param {Adapter} v pathname
     * @return {Server|Adapter} self when setting or value when getting
     */
    public adapter(v) {
        if (!arguments.length) return this._adapter;
        this._adapter = v;
        // 所有命名空间对象都需要初始化适配器
        for (const nsp of this.nsps.values()) {
            nsp.initAdapter();
        }
        return this;
    }

    /**
     * Sets the allowed origins for requests.设置允许的源，解决跨域问题
     *
     * @param {String|String[]} v origins
     * @return {Server|Adapter} self when setting or value when getting
     */
    public origins(v) {
        if (!arguments.length) return this._origins;

        this._origins = v;
        return this;
    }

    /**
     * Attaches socket.io to a server or port.关联socket.io到一个服务器
     *
     * @param {http.Server|Number} srv - server or port
     * @param {Object} opts - options passed to engine.io
     * @return {Server} self
     */
    public listen(srv: http.Server, opts?: Partial<ServerOptions>): Server;
    public listen(srv: number, opts?: Partial<ServerOptions>): Server;
    public listen(srv: any, opts: Partial<ServerOptions> = {}): Server {
        return this.attach(srv, opts);
    }

    /**
     * Attaches socket.io to a server or port.关联socket.io到服务器或端口
     *
     * @param {http.Server|Number} srv - server or port
     * @param {Object} opts - options passed to engine.io
     * @return {Server} self
     */
    public attach(srv: http.Server, opts?: Partial<ServerOptions>): Server;
    public attach(port: number, opts?: Partial<ServerOptions>): Server;
    public attach(srv: any, opts: Partial<ServerOptions> = {}): Server {
        if ("function" == typeof srv) {
            const msg =
                "You are trying to attach socket.io to an express " +
                "request handler function. Please pass a http.Server instance.";
            throw new Error(msg);
        }

        // handle a port as a string
        if (Number(srv) == srv) { // 如果传入端口
            srv = Number(srv);
        }

        if ("number" == typeof srv) { // 在指定端口创建http服务器
            debug("creating http server and binding to %d", srv);
            const port = srv;
            srv = http.createServer((req, res) => {
                res.writeHead(404);
                res.end();
            });
            srv.listen(port);
        }

        // set engine.io path to `/socket.io`
        opts.path = opts.path || this._path;
        // set origins verification 检查当前请求是否允许的函数
        opts.allowRequest = opts.allowRequest || this.checkRequest.bind(this);

        // 如果默认命名空间存在中间件，则初始化底层engine.io引擎
        if (this.sockets.fns.length > 0) {
            this.initEngine(srv, opts);
            return this;
        }

        // 发出SocketIO连接包，难道是因为中间件可能会检查不通过，所以不能先响应连接包
        const connectPacket = {type: PacketType.CONNECT, nsp: "/"};
        // the CONNECT packet will be merged with Engine.IO handshake,
        // to reduce the number of round trips
        opts.initialPacket = this.encoder.encode(connectPacket);

        this.initEngine(srv, opts);

        return this;
    }

    /**
     * Initialize engine，使用opts选项创建engine.io引擎
     *
     * @param srv - the server to attach to
     * @param opts - options passed to engine.io
     */
    private initEngine(srv: http.Server, opts: Partial<EngineAttachOptions>) {
        // initialize engine
        debug("creating engine.io instance with opts %j", opts);
        this.eio = engine.attach(srv, opts);

        // attach static file serving，返回客户端脚本文件服务
        if (this._serveClient) this.attachServe(srv);

        // Export http server
        this.httpServer = srv;

        // bind to engine events
        this.bind(this.eio); // 初始化绑定函数到底层引擎事件上
    }

    /**
     * Attaches the static file serving.返回客户端脚本文件服务
     *
     * @param {Function|http.Server} srv http server
     */
    private attachServe(srv) {
        debug("attaching client serving req handler");
        const url = this._path + "/socket.io.js";
        const urlMap = this._path + "/socket.io.js.map";
        const evs = srv.listeners("request").slice(0);
        const self = this;
        srv.removeAllListeners("request");
        srv.on("request", function (req, res) {
            if (0 === req.url.indexOf(urlMap)) {
                self.serveMap(req, res);
            } else if (0 === req.url.indexOf(url)) {
                self.serve(req, res);
            } else {
                for (let i = 0; i < evs.length; i++) {
                    evs[i].call(srv, req, res);
                }
            }
        });
    }

    /**
     * Handles a request serving `/socket.io.js`
     * 返回给客户端/socket.io.js文件
     *
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     */
    private serve(req: http.IncomingMessage, res: http.ServerResponse) {
        // Per the standard, ETags must be quoted:
        // https://tools.ietf.org/html/rfc7232#section-2.3
        const expectedEtag = '"' + clientVersion + '"';

        const etag = req.headers["if-none-match"];
        if (etag) {
            if (expectedEtag == etag) {
                debug("serve client 304");
                res.writeHead(304);
                res.end();
                return;
            }
        }

        debug("serve client source");
        res.setHeader("Cache-Control", "public, max-age=0");
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("ETag", expectedEtag);
        res.writeHead(200);
        res.end(clientSource);
    }

    /**
     * Handles a request serving `/socket.io.js.map`
     * 返回给客户端/socket.io.js.map文件
     *
     * @param {http.IncomingMessage} req
     * @param {http.ServerResponse} res
     */
    private serveMap(req: http.IncomingMessage, res: http.ServerResponse) {
        // Per the standard, ETags must be quoted:
        // https://tools.ietf.org/html/rfc7232#section-2.3
        const expectedEtag = '"' + clientVersion + '"';

        const etag = req.headers["if-none-match"];
        if (etag) {
            if (expectedEtag == etag) {
                debug("serve client 304");
                res.writeHead(304);
                res.end();
                return;
            }
        }

        debug("serve client sourcemap");
        res.setHeader("Content-Type", "application/json");
        res.setHeader("ETag", expectedEtag);
        res.writeHead(200);
        res.end(clientSourceMap);
    }

    /**
     * Binds socket.io to an engine.io instance.
     * 绑定底层引擎，并绑定函数到底层engine.io实例事件上
     *
     * @param {engine.Server} engine engine.io (or compatible) server
     * @return {Server} self
     */
    public bind(engine): Server {
        this.engine = engine;
        // 绑定底层引擎的连接事件，当连接建立时触发方法并传入底层连接对象
        this.engine.on("connection", this.onconnection.bind(this));
        return this;
    }

    /**
     * Called with each incoming transport connection.
     * 在每个传入的传输连接中调用。
     *
     * @param {engine.Socket} conn 底层连接
     * @return {Server} self
     */
    private onconnection(conn): Server {
        debug("incoming connection with id %s", conn.id);
        // 创建一个SocketIO连接对象
        const client = new Client(this, conn);
        client.connect("/"); // 默认自动连接到默认命名空间
        return this;
    }

    /**
     * Looks up a namespace.查找命名空间，返回命名空间实例对象
     *
     * @param {String|RegExp|Function} name nsp name
     * @param {Function} [fn] optional, nsp `connection` ev handler
     */
    public of(
        name:
            | string
            | RegExp
            | ((
            name: string,
            query: object,
            fn: (err: Error, success: boolean) => void
        ) => void),
        fn?: (socket: Socket) => void
    ) {
        // 如果名称是函数或者正则表达式
        if (typeof name === "function" || name instanceof RegExp) {
            // 创建父命名空间
            const parentNsp = new ParentNamespace(this);
            debug("initializing parent namespace %s", parentNsp.name);
            if (typeof name === "function") { // 对于名称是函数，建立函数和父命名空间映射关系
                this.parentNsps.set(name, parentNsp);
            } else { // 如果是正则表达式，则用函数封装，然后建立函数和父命名空间映射关系
                this.parentNsps.set(
                    (nsp, conn, next) => next(null, (name as RegExp).test(nsp)),
                    parentNsp
                );
            }
            if (fn) {
                // @ts-ignore
                parentNsp.on("connect", fn); // 注册监听connect函数
            }
            return parentNsp;
        }

        // 如果传入的是普通名称，则获取指定名称的命令空间对象
        if (String(name)[0] !== "/") name = "/" + name;
        let nsp = this.nsps.get(name); // 通过名称获取命名空间对象
        if (!nsp) { // 如果没有找到，则创建一个该名称的命名空间对象
            debug("initializing namespace %s", name);
            nsp = new Namespace(this, name);
            this.nsps.set(name, nsp); // 建立名称和命名空间对象映射关系
        }
        // 如果传入第二个函数参数，则注册监听connect函数
        if (fn) nsp.on("connect", fn);
        return nsp;
    }

    /**
     * Closes server connection 关闭SocketIO服务器
     *
     * @param {Function} [fn] optional, called as `fn([err])` on error OR all conns closed
     */
    public close(fn: (err?: Error) => void): void {
        // 关闭默认命名空间的所有Socket连接
        for (const socket of this.sockets.sockets.values()) {
            socket.onclose("server shutting down");
        }

        this.engine.close(); // 关闭底层连接

        if (this.httpServer) { // 关闭http服务器
            this.httpServer.close(fn); // 最后执行回调函数
        } else {
            fn && fn();
        }
    }
}

/**
 * Expose main namespace (/).
 */

// 获取EventEmitter类的所有方法
const emitterMethods = Object.keys(EventEmitter.prototype).filter(function (
    key
) {
    return typeof EventEmitter.prototype[key] === "function";
});

// 把EventEmitter、默认命名空间对象的方法代理到Server类对象上
emitterMethods
    .concat(["to", "in", "use", "send", "write", "clients", "compress", "binary"])
    .forEach(function (fn) {
        Server.prototype[fn] = function () {
            // 默认命名空间对象
            return this.sockets[fn].apply(this.sockets, arguments);
        };
    });

// 当在Server类上访问json/volatile/local属性时，会把默认命名空间的flags中对应flag设置为true
["json", "volatile", "local"].forEach(function (flag) {
    Object.defineProperty(Server.prototype, flag, {
        get: function () {
            // 默认命名空间对象
            this.sockets.flags = this.sockets.flags || {};
            this.sockets.flags[flag] = true;
            return this;
        }
    });
});

export {Server, Namespace, ParentNamespace, Client};
export * from "./socket";
module.exports = (srv?, opts?) => new Server(srv, opts);
