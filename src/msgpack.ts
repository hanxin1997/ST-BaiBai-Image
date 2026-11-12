/**
 * 最小 MessagePack 解码器(只读)。
 *
 * 为什么自己写而不是加依赖:NAI V5 的流式响应只需要解「事件对象」这一种形状,
 * 用到的类型屈指可数;为它引入一个运行时依赖,会让插件的 dist 体积和供应链面
 * 都为一个几十行的解析器买单。
 *
 * 支持:nil / bool / int / uint / float / str / bin / array / map。
 * ext 类型不参与 V5 事件,遇到直接报错,避免把二进制误当成图片。
 */

export class MessagePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagePackError';
  }
}

export type MessagePackValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | MessagePackValue[]
  | { [key: string]: MessagePackValue };

/** 防御恶意/损坏数据:正常 V5 事件嵌套不超过 3 层。 */
const MAX_NESTING_DEPTH = 64;
const TEXT_DECODER = new TextDecoder();

class Reader {
  private offset = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  readValue(depth = 0): MessagePackValue {
    if (depth > MAX_NESTING_DEPTH) throw new MessagePackError('MessagePack 嵌套层级过深');
    const prefix = this.readByte();
    if (prefix <= 0x7f) return prefix;
    if (prefix >= 0xe0) return prefix - 0x100;
    if ((prefix & 0xf0) === 0x80) return this.readMap(prefix & 0x0f, depth);
    if ((prefix & 0xf0) === 0x90) return this.readArray(prefix & 0x0f, depth);
    if ((prefix & 0xe0) === 0xa0) return this.readString(prefix & 0x1f);
    return this.readTypedValue(prefix, depth);
  }

  private readTypedValue(prefix: number, depth: number): MessagePackValue {
    switch (prefix) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return this.readBytes(this.readUint8());
      case 0xc5:
        return this.readBytes(this.readUint16());
      case 0xc6:
        return this.readBytes(this.readUint32());
      case 0xca:
        return this.readFloat32();
      case 0xcb:
        return this.readFloat64();
      case 0xcc:
        return this.readUint8();
      case 0xcd:
        return this.readUint16();
      case 0xce:
        return this.readUint32();
      case 0xcf:
        return this.readUint64();
      case 0xd0:
        return this.readInt8();
      case 0xd1:
        return this.readInt16();
      case 0xd2:
        return this.readInt32();
      case 0xd3:
        return this.readInt64();
      case 0xd9:
        return this.readString(this.readUint8());
      case 0xda:
        return this.readString(this.readUint16());
      case 0xdb:
        return this.readString(this.readUint32());
      case 0xdc:
        return this.readArray(this.readUint16(), depth);
      case 0xdd:
        return this.readArray(this.readUint32(), depth);
      case 0xde:
        return this.readMap(this.readUint16(), depth);
      case 0xdf:
        return this.readMap(this.readUint32(), depth);
      default:
        throw new MessagePackError(`不支持的 MessagePack 类型:0x${prefix.toString(16)}`);
    }
  }

  private readMap(length: number, depth: number): { [key: string]: MessagePackValue } {
    // 每个键值对至少 2 字节;先按剩余长度拒绝离谱的声明,避免预分配巨量内存
    this.require(length * 2);
    const out: { [key: string]: MessagePackValue } = {};
    for (let index = 0; index < length; index++) {
      const key = this.readValue(depth + 1);
      if (typeof key !== 'string') throw new MessagePackError('MessagePack 对象的键不是字符串');
      out[key] = this.readValue(depth + 1);
    }
    return out;
  }

  private readArray(length: number, depth: number): MessagePackValue[] {
    this.require(length);
    const out: MessagePackValue[] = new Array(length);
    for (let index = 0; index < length; index++) out[index] = this.readValue(depth + 1);
    return out;
  }

  private readString(length: number): string {
    return TEXT_DECODER.decode(this.readBytes(length));
  }

  private readBytes(length: number): Uint8Array {
    this.require(length);
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  private readByte(): number {
    this.require(1);
    return this.bytes[this.offset++];
  }

  private readUint8(): number {
    return this.readByte();
  }

  private readUint16(): number {
    return this.readNumber(2, offset => this.view.getUint16(offset));
  }

  private readUint32(): number {
    return this.readNumber(4, offset => this.view.getUint32(offset));
  }

  private readUint64(): number {
    return this.readNumber(8, offset => Number(this.view.getBigUint64(offset)));
  }

  private readInt8(): number {
    return this.readNumber(1, offset => this.view.getInt8(offset));
  }

  private readInt16(): number {
    return this.readNumber(2, offset => this.view.getInt16(offset));
  }

  private readInt32(): number {
    return this.readNumber(4, offset => this.view.getInt32(offset));
  }

  private readInt64(): number {
    return this.readNumber(8, offset => Number(this.view.getBigInt64(offset)));
  }

  private readFloat32(): number {
    return this.readNumber(4, offset => this.view.getFloat32(offset));
  }

  private readFloat64(): number {
    return this.readNumber(8, offset => this.view.getFloat64(offset));
  }

  private readNumber(length: number, read: (offset: number) => number): number {
    this.require(length);
    const value = read(this.offset);
    this.offset += length;
    return value;
  }

  private require(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new MessagePackError('MessagePack 数据在读取时被截断');
    }
  }
}

export function decodeMessagePack(bytes: Uint8Array): MessagePackValue {
  const reader = new Reader(bytes);
  const value = reader.readValue();
  if (!reader.done) throw new MessagePackError('MessagePack 数据末尾有多余字节');
  return value;
}
