/**
 * Just enough of a DOM for react-dom/client to mount into and run effects, so a component test can
 * exercise the real hooks and state (the node test environment has no document, and the repo does not
 * carry jsdom). `installMiniDom()` must run before react-dom/client is first imported.
 */
class MiniNode {
  nodeType: number;
  nodeName: string;
  parentNode: MiniNode | null = null;
  childNodes: MiniNode[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  ownerDocument: unknown;
  text = '';

  constructor(nodeType: number, nodeName: string, ownerDocument: unknown) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  /** React writes a lone string child through textContent (elements) or nodeValue (text nodes). */
  get textContent() { return this.nodeType === 3 ? this.text : this.childNodes.map(c => c.textContent).join(''); }
  set textContent(value: string) {
    if (this.nodeType === 3) { this.text = value; return; }
    this.childNodes.forEach(c => { c.parentNode = null; });
    this.childNodes = [];
    if (value) this.appendChild(Object.assign(new MiniNode(3, '#text', this.ownerDocument), { text: value }));
  }
  get nodeValue() { return this.text; }
  set nodeValue(value: string) { this.text = value; }
  get tagName() { return this.nodeName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling(): MiniNode | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }

  private detach(child: MiniNode) {
    child.parentNode?.childNodes.splice(child.parentNode.childNodes.indexOf(child), 1);
    child.parentNode = null;
  }
  appendChild(child: MiniNode) { this.insertBefore(child, null); return child; }
  insertBefore(child: MiniNode, before: MiniNode | null) {
    this.detach(child);
    child.parentNode = this;
    if (before) this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    else this.childNodes.push(child);
    return child;
  }
  removeChild(child: MiniNode) { this.detach(child); return child; }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener() {}
  removeEventListener() {}
}

/** The text a node and its descendants hold, tags removed. */
export function textOf(node: MiniNode): string {
  return node.textContent;
}

/** Every element below `node` that carries the attribute `name`. */
export function withAttribute(node: MiniNode, name: string): MiniNode[] {
  return node.childNodes.flatMap(c => [...(name in c.attributes ? [c] : []), ...withAttribute(c, name)]);
}

export function installMiniDom() {
  const document: Record<string, unknown> = {};
  Object.assign(document, {
    nodeType: 9,
    nodeName: '#document',
    createElement: (tag: string) => new MiniNode(1, tag.toUpperCase(), document),
    createElementNS: (_ns: string, tag: string) => new MiniNode(1, tag.toUpperCase(), document),
    createTextNode: (text: string) => Object.assign(new MiniNode(3, '#text', document), { text }),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    documentElement: new MiniNode(1, 'HTML', document),
  });
  const g = globalThis as Record<string, unknown>;
  g.document = document;
  g.window = g;
  g.HTMLIFrameElement = class {};
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return { container: () => new MiniNode(1, 'DIV', document) };
}
