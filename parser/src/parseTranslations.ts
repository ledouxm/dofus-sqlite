import fs from "fs/promises";
import { Buffer } from "buffer";

interface Entry {
  id: number;
  offset: number;
  data?: string;
}

class BinaryParser {
  private buffer: Buffer;
  private position: number = 0;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  private readUInt8(): number {
    const value = this.buffer.readUInt8(this.position);
    this.position += 1;
    return value;
  }

  private readUInt32LE(): number {
    const value = this.buffer.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  private readEntry(): Entry | null {
    if (this.position >= this.buffer.length - 8) {
      return null;
    }

    const id = this.readUInt8();
    // Skip 3 bytes (possibly flags or padding)
    this.position += 3;
    const offset = this.readUInt32LE();

    return {
      id,
      offset,
    };
  }

  private readStringAtOffset(offset: number): string {
    // Store current position
    const originalPosition = this.position;

    // Move to offset
    this.position = offset;

    // Read until we hit a null terminator or pattern break
    let result = "";
    let byte;
    while (this.position < this.buffer.length) {
      byte = this.buffer[this.position];
      if (byte === 0 || byte === 0x69) {
        // Stop at null or pattern break
        break;
      }
      result += String.fromCharCode(byte);
      this.position++;
    }

    // Restore position
    this.position = originalPosition;

    return result.trim();
  }

  async parse(): Promise<Map<number, string>> {
    const entries = new Map<number, string>();

    // Read file format version
    const version = this.readUInt8();
    console.log("File version:", version);

    // Skip header bytes if needed
    this.position = 1; // Start after version byte

    let entry: Entry | null;
    const offsets: Entry[] = [];

    // First pass: collect all entries and offsets
    while ((entry = this.readEntry()) !== null) {
      offsets.push(entry);
    }

    // Second pass: read strings using offsets
    for (let i = 0; i < offsets.length; i++) {
      const currentOffset = offsets[i].offset;
      const nextOffset =
        i < offsets.length - 1 ? offsets[i + 1].offset : this.buffer.length;

      const str = this.readStringAtOffset(currentOffset);
      entries.set(offsets[i].id, str);
    }

    return entries;
  }
}

export async function parseBinFile(filePath: string): Promise<void> {
  try {
    const fileBuffer = await fs.readFile(filePath);
    const parser = new BinaryParser(fileBuffer);

    console.log("Parsing file...");
    const entries = await parser.parse();

    console.log("\nParsed Entries:");
    entries.forEach((value, key) => {
      console.log(`ID ${key}: ${value}`);
    });
  } catch (error) {
    console.error("Failed to parse file:", error);
  }
}
