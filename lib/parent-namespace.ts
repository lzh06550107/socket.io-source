import { Namespace } from "./namespace";

// 动态命名空间，即通过函数或者正则表达式创建的
export class ParentNamespace extends Namespace {
  private static count: number = 0;
  private children: Set<Namespace> = new Set();

  constructor(server) {
    super(server, "/_" + ParentNamespace.count++);
  }

  initAdapter() {}

  /**
   * 给其下的所有命名空间的所有连接发送消息
   * @param args
   */
  public emit(...args): Namespace {
    this.children.forEach(nsp => {
      nsp.rooms = this.rooms;
      nsp.flags = this.flags;
      nsp.emit.apply(nsp, args);
    });
    this.rooms.clear();
    this.flags = {};

    return this;
  }

  /**
   * 在当前动态命名空间下，创建其子命名空间对象
   * @param name
   */
  createChild(name) {
    const namespace = new Namespace(this.server, name);
    namespace.fns = this.fns.slice(0); // 复制父命名空间的中间件
    // 复制父命名空间的事件监听器到子命名空间
    this.listeners("connect").forEach(listener =>
      // @ts-ignore
      namespace.on("connect", listener)
    );
    this.listeners("connection").forEach(listener =>
      // @ts-ignore
      namespace.on("connection", listener)
    );
    // 把子命名空间添加到孩子集合中
    this.children.add(namespace);
    // 最终还是在服务器命名空间集合中注册，命名空间名称和对象之间映射关系
    this.server.nsps.set(name, namespace);
    return namespace;
  }
}
