/**
 * Qualcomm Snapdragon GPT Partition Table Parser
 *
 * Supports:
 *  - Standard GPT images (full disk image with Protective MBR at LBA 0)
 *  - gpt_main0.bin   : Primary GPT only (MBR 512B + header + entries)
 *  - gpt_backup0.bin : Backup GPT only
 *  - gpt_both0.bin   : Primary + Backup GPT tables concatenated
 *  - Sector sizes: 512 bytes (eMMC) and 4096 bytes (UFS)
 *
 * GPT Standard Layout (512-byte sectors):
 *   LBA 0: Protective MBR (512 bytes)
 *   LBA 1: Primary GPT Header (512 bytes), magic = "EFI PART"
 *   LBA 2..33: Partition Entry Array (128 entries × 128 bytes = 16384 bytes = 32 sectors)
 *   ...data...
 *   LBA -33..-2: Backup Partition Entry Array
 *   LBA -1: Backup GPT Header
 *
 * GPT Header structure (92 bytes, little-endian):
 *   0x00  8B  Signature "EFI PART"
 *   0x08  4B  Revision (00 00 01 00 = v1.0)
 *   0x0C  4B  Header size (usually 92 = 0x5C)
 *   0x10  4B  CRC32 of header (with this field = 0)
 *   0x14  4B  Reserved (0)
 *   0x18  8B  Current LBA
 *   0x20  8B  Backup/Alternate LBA
 *   0x28  8B  First usable LBA
 *   0x30  8B  Last usable LBA
 *   0x38 16B  Disk GUID
 *   0x48  8B  Partition Entry Array starting LBA
 *   0x50  4B  Number of partition entries
 *   0x54  4B  Size of partition entry (usually 128)
 *   0x58  4B  CRC32 of partition array
 *
 * GPT Partition Entry (128 bytes):
 *   0x00 16B  Partition Type GUID
 *   0x10 16B  Unique Partition GUID
 *   0x20  8B  Starting LBA
 *   0x28  8B  Ending LBA (inclusive)
 *   0x30  8B  Attribute flags
 *   0x38 72B  Partition name (UTF-16LE, max 36 chars)
 */

export interface GptHeader {
  signature: string;
  revision: string;
  headerSize: number;
  headerCrc32: number;
  currentLba: bigint;
  backupLba: bigint;
  firstUsableLba: bigint;
  lastUsableLba: bigint;
  diskGuid: string;
  partitionEntryLba: bigint;
  numPartitionEntries: number;
  partitionEntrySize: number;
  partitionArrayCrc32: number;
  crcValid: boolean;
  offset: number; // byte offset where this header was found
}

export interface GptPartitionEntry {
  index: number;
  typeGuid: string;
  typeName: string;
  typeOs: string;
  uniqueGuid: string;
  startLba: bigint;
  endLba: bigint;
  sizeSectors: bigint;
  sizeBytes: bigint;
  sizeHuman: string;
  attributes: bigint;
  attributeDesc: string[];
  name: string;
  bootable: boolean;
}

export interface GptParseResult {
  fileSize: number;
  sectorSize: number;
  detectedFormat: string;
  primaryHeader: GptHeader | null;
  backupHeader: GptHeader | null;
  partitions: GptPartitionEntry[];
  warnings: string[];
  errors: string[];
  hexDump: string; // first 512 bytes hex dump
}

// const GPT_MAGIC = "EFI PART"; // kept for reference
const GPT_MAGIC_BYTES = [0x45, 0x46, 0x49, 0x20, 0x50, 0x41, 0x52, 0x54];

// Known Qualcomm partition type GUIDs
const QUALCOMM_GUIDS: Record<string, [string, string]> = {
  "DEA0BA2C-CBDD-4805-B4F9-F428251C3E98": ["SBL1", "Qualcomm"],
  "8C6B52AD-8A9E-4398-AD09-AE916E53AE2D": ["SBL2", "Qualcomm"],
  "05E044DF-92F1-4325-B69E-374A82E97D6E": ["SBL3", "Qualcomm"],
  "400FFDCD-22E0-47E7-9A23-F16ED9382388": ["APPSBL (aboot)", "Qualcomm"],
  "A053AA7F-40B8-4B1C-BA08-2F68AC71A4F4": ["QSEE (TrustZone)", "Qualcomm"],
  "E1A6A689-0C8D-4CC6-B4E8-55A4320FBD8A": ["QHEE (HYP)", "Qualcomm"],
  "098DF793-D712-413D-9D4E-89D711772228": ["RPM", "Qualcomm"],
  "D4E0D938-B7FA-48C1-9D21-BC5ED5C4B203": ["WDOG Debug", "Qualcomm"],
  "20A0C19C-286A-42FA-9CE7-F64C3226A794": ["DDR", "Qualcomm"],
  "A19F205F-CCD8-4B6D-8F1E-2D9BC24CFFB1": ["CDT", "Qualcomm"],
  "66C9B323-F7FC-48B6-BF96-6F32E335A428": ["RAM Dump", "Qualcomm"],
  "303E6AC3-AF15-4C54-9E9B-D9A8FBECF401": ["SEC", "Qualcomm"],
  "C00EEF24-7709-43D6-9799-DD2B411E7A3C": ["PMIC Config", "Qualcomm"],
  "82ACC91F-357C-4A68-9C8F-689E1B1A23A1": ["MISC", "Qualcomm"],
  "10A0C19C-516A-5444-5CE3-664C3226A794": ["LIMITS", "Qualcomm"],
  "65ADDCF4-0C5C-4D9A-AC2D-D90B5CBFCD03": ["DEVINFO", "Qualcomm"],
  "E6E98DA2-E22A-4D12-AB33-169E7DEAA507": ["APDP", "Qualcomm"],
  "ED9E8101-05FA-46B7-82AA-8D58770D200B": ["MSADP", "Qualcomm"],
  "11406F35-1173-4869-807B-27DF71802812": ["DPO", "Qualcomm"],
  "DF24E5ED-8C96-4B86-B00B-79667DC6DE11": ["SPARE1", "Qualcomm"],
  "6C95E238-E343-4BA8-B489-8681ED22AD0B": ["PERSIST", "Qualcomm"],
  "EBBEADAF-22C9-E33B-8F5D-0E81686A68CB": ["MODEMST1", "Qualcomm"],
  "0A288B1F-22C9-E33B-8F5D-0E81686A68CB": ["MODEMST2", "Qualcomm"],
  "638FF8E2-22C9-E33B-8F5D-0E81686A68CB": ["FSG", "Qualcomm"],
  "57B90A16-22C9-E33B-8F5D-0E81686A68CB": ["FSC", "Qualcomm"],
  "2C86E742-745E-4FDD-BFD8-B6A7AC638772": ["SSD", "Qualcomm"],
  "DE7D4029-0F5B-41C8-AE7E-F6C023A02B33": ["KEYSTORE", "Qualcomm"],
  "323EF595-AF7A-4AFA-8060-97BE72841BB9": ["ENCRYPT", "Qualcomm"],
  "45864011-CF89-46E6-A445-85262E065604": ["EKSST", "Qualcomm"],
  "8ED8AE95-597F-4C8A-A5BD-A7FF8E4DFAA9": ["RCT", "Qualcomm"],
  "7C29D3AD-78B9-452E-9DEB-D098D542F092": ["SPARE2", "Qualcomm"],
  "9D72D4E4-9958-42DA-AC26-BEA7A90B0434": ["RECOVERY", "Qualcomm"],
  "4627AE27-CFEF-48A1-88FE-99C3509ADE26": ["raw_resources", "Qualcomm"],
  "20117F86-E985-4357-B9EE-374BC1D8487D": ["BOOT", "Qualcomm"],
  "379D107E-229E-499D-AD4F-61F5BCF87BD4": ["SPARE3", "Qualcomm"],
  "86A7CB80-84E1-408C-99AB-694F1A410FC7": ["FOTA", "Qualcomm"],
  "0DEA65E5-A676-4CDF-823C-77568B577ED5": ["SPARE4", "Qualcomm"],
  "97D7B011-54DA-4835-B3C4-917AD6E73D74": ["SYSTEM", "Qualcomm"],
  "5594C694-C871-4B5F-90B1-690A6F68E0F7": ["CACHE", "Qualcomm"],
  "1B81E7E6-F50D-419B-A739-2AEEF8DA3335": ["USERDATA", "Qualcomm"],
  // Additional Qualcomm / Android common
  "9D7028D5-F96F-4F6A-B6D5-E2B60E1E32D2": ["MODEM", "Qualcomm"],
  "DE3B39D2-CBDD-4805-B4F9-F428251C3E98": ["SBL1BAK", "Qualcomm"],
  "F1CA4AF3-A4EF-4197-9B10-4B34E0B3E23B": ["ABOOTBAK", "Qualcomm"],
  "72C95E91-30C6-4806-A8EB-EAD8D26DA27A": ["TZBAK", "Qualcomm"],
  "A8B9BB31-D6E4-4B7F-B444-C3D98AF99B75": ["RPMBAK", "Qualcomm"],
  "24D0D418-D31D-11E3-9253-080027BC1258": ["hyp", "Qualcomm"],
  // Generic
  "C12A7328-F81F-11D2-BA4B-00A0C93EC93B": ["EFI System Partition", "EFI"],
  "21686148-6449-6E6F-744E-656564454649": ["BIOS Boot", "EFI"],
  "EBD0A0A2-B9E5-4433-87C0-68B6B72699C7": ["Basic Data / Linux fs", "Generic"],
  "0FC63DAF-8483-4772-8E79-3D69D8477DE4": ["Linux Filesystem", "Linux"],
  "A19D880F-05FC-4D3B-A006-743F0F84911E": ["Linux RAID", "Linux"],
  "0657FD6D-A4AB-43C4-84E5-0933C84B4F4F": ["Linux Swap", "Linux"],
  "E6D6D379-F507-44C2-A23C-238F2A3DF928": ["Linux LVM", "Linux"],
  "024DEE41-33E7-11D3-9D69-0008C781F39F": ["MBR Partition Scheme", "MBR"],
  "E3C9E316-0B5C-4DB8-817D-F92DF00215AE": ["Microsoft Reserved", "Windows"],
  "DE94BBA4-06D1-4D40-A16A-BFD50179D6AC": ["Windows Recovery", "Windows"],
  // Android A/B slot partitions
  "9D72D4E4-9958-42DA-AC26-BEA7A90B0435": ["RECOVERY_B", "Qualcomm"],
  "20117F86-E985-4357-B9EE-374BC1D8487E": ["BOOT_B", "Qualcomm"],
};

function lookupGuid(guid: string): [string, string] {
  const upper = guid.toUpperCase();
  if (QUALCOMM_GUIDS[upper]) return QUALCOMM_GUIDS[upper];
  return ["Unknown", "Unknown"];
}

/**
 * Convert bytes to GUID string (little-endian mixed endian format as used in GPT)
 * GPT GUIDs use mixed endianness:
 *   - First 3 components (4B, 2B, 2B) are stored little-endian
 *   - Last 2 components (2B, 6B) are stored big-endian
 */
function bytesToGuid(bytes: Uint8Array, offset: number): string {
  const b = bytes;
  const o = offset;
  // Component 1: 4 bytes LE
  const p1 = (
    (b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o + 0]
  ) >>> 0;
  // Component 2: 2 bytes LE
  const p2 = ((b[o + 5] << 8) | b[o + 4]) >>> 0;
  // Component 3: 2 bytes LE
  const p3 = ((b[o + 7] << 8) | b[o + 6]) >>> 0;
  // Component 4: 2 bytes BE
  const p4 = ((b[o + 8] << 8) | b[o + 9]) >>> 0;
  // Component 5: 6 bytes BE
  const p5 = [b[o + 10], b[o + 11], b[o + 12], b[o + 13], b[o + 14], b[o + 15]];

  const toHex = (n: number, len: number) => n.toString(16).toUpperCase().padStart(len, "0");
  const p5hex = p5.map(x => x.toString(16).toUpperCase().padStart(2, "0")).join("");

  return `${toHex(p1, 8)}-${toHex(p2, 4)}-${toHex(p3, 4)}-${toHex(p4, 4)}-${p5hex}`;
}

function readUint32LE(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0
  );
}

function readUint64LE(buf: Uint8Array, offset: number): bigint {
  const lo = BigInt(readUint32LE(buf, offset));
  const hi = BigInt(readUint32LE(buf, offset + 4));
  return (hi << 32n) | lo;
}

function readUtf16LE(buf: Uint8Array, offset: number, maxBytes: number): string {
  const chars: string[] = [];
  for (let i = 0; i < maxBytes; i += 2) {
    const code = buf[offset + i] | (buf[offset + i + 1] << 8);
    if (code === 0) break;
    chars.push(String.fromCodePoint(code));
  }
  return chars.join("");
}

/**
 * CRC32 implementation (standard IEEE 802.3 polynomial)
 */
function makeCrc32Table(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}
const CRC32_TABLE = makeCrc32Table();

function crc32(data: Uint8Array, start = 0, length = data.length - start): number {
  let crc = 0xffffffff;
  for (let i = start; i < start + length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatSize(bytes: bigint): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let val = Number(bytes);
  let u = 0;
  while (val >= 1024 && u < units.length - 1) {
    val /= 1024;
    u++;
  }
  return `${val.toFixed(u > 0 ? 2 : 0)} ${units[u]}`;
}

function formatAttributeFlags(flags: bigint): string[] {
  const result: string[] = [];
  if (flags & 1n) result.push("Required Partition");
  if (flags & 2n) result.push("No auto-mount");
  if (flags & 4n) result.push("Legacy BIOS Bootable");
  // Qualcomm-specific bits (bits 48-63 are partition-type specific)
  if (flags & (1n << 60n)) result.push("Read-Only");
  if (flags & (1n << 62n)) result.push("Hidden");
  if (flags & (1n << 63n)) result.push("Do Not Auto-mount");
  if (result.length === 0) result.push("None");
  return result;
}

/**
 * Try to find the GPT magic "EFI PART" at a given byte offset in the buffer.
 */
function findMagicAt(buf: Uint8Array, offset: number): boolean {
  if (offset + 8 > buf.length) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[offset + i] !== GPT_MAGIC_BYTES[i]) return false;
  }
  return true;
}

/**
 * Parse a GPT header starting at `headerOffset` bytes.
 * Returns null if magic not found or header too short.
 */
function parseGptHeader(buf: Uint8Array, headerOffset: number, _sectorSize: number): GptHeader | null {
  if (headerOffset + 92 > buf.length) return null;
  if (!findMagicAt(buf, headerOffset)) return null;

  const sig = String.fromCharCode(...buf.slice(headerOffset, headerOffset + 8));
  const rev0 = buf[headerOffset + 8];
  const rev1 = buf[headerOffset + 9];
  const rev2 = buf[headerOffset + 10];
  const rev3 = buf[headerOffset + 11];
  const revision = `${rev2}.${rev3} (${rev0}.${rev1})`;
  const headerSize = readUint32LE(buf, headerOffset + 0x0c);
  const headerCrc32 = readUint32LE(buf, headerOffset + 0x10);
  const currentLba = readUint64LE(buf, headerOffset + 0x18);
  const backupLba = readUint64LE(buf, headerOffset + 0x20);
  const firstUsableLba = readUint64LE(buf, headerOffset + 0x28);
  const lastUsableLba = readUint64LE(buf, headerOffset + 0x30);
  const diskGuid = bytesToGuid(buf, headerOffset + 0x38);
  const partitionEntryLba = readUint64LE(buf, headerOffset + 0x48);
  const numPartitionEntries = readUint32LE(buf, headerOffset + 0x50);
  const partitionEntrySize = readUint32LE(buf, headerOffset + 0x54);
  const partitionArrayCrc32 = readUint32LE(buf, headerOffset + 0x58);

  // Validate header CRC32: zero out the CRC field and compute
  const headerBuf = new Uint8Array(buf.slice(headerOffset, headerOffset + Math.min(headerSize, 512)));
  headerBuf[0x10] = 0;
  headerBuf[0x11] = 0;
  headerBuf[0x12] = 0;
  headerBuf[0x13] = 0;
  const computedCrc = crc32(headerBuf, 0, headerSize);
  const crcValid = computedCrc === headerCrc32;

  return {
    signature: sig,
    revision,
    headerSize,
    headerCrc32,
    currentLba,
    backupLba,
    firstUsableLba,
    lastUsableLba,
    diskGuid,
    partitionEntryLba,
    numPartitionEntries,
    partitionEntrySize,
    partitionArrayCrc32,
    crcValid,
    offset: headerOffset,
  };
}

/**
 * Parse partition entries starting at byte offset `entriesOffset`.
 */
function parsePartitionEntries(
  buf: Uint8Array,
  entriesOffset: number,
  count: number,
  entrySize: number,
  sectorSize: number
): GptPartitionEntry[] {
  const result: GptPartitionEntry[] = [];
  let idx = 0;

  for (let i = 0; i < count; i++) {
    const off = entriesOffset + i * entrySize;
    if (off + entrySize > buf.length) break;

    // Check if entry is empty (all zeros in type GUID)
    let isEmpty = true;
    for (let j = 0; j < 16; j++) {
      if (buf[off + j] !== 0) { isEmpty = false; break; }
    }
    if (isEmpty) continue;

    const typeGuid = bytesToGuid(buf, off + 0x00);
    const uniqueGuid = bytesToGuid(buf, off + 0x10);
    const startLba = readUint64LE(buf, off + 0x20);
    const endLba = readUint64LE(buf, off + 0x28);
    const attributes = readUint64LE(buf, off + 0x30);
    const name = readUtf16LE(buf, off + 0x38, Math.min(72, entrySize - 0x38));

    const [typeName, typeOs] = lookupGuid(typeGuid);
    const sizeSectors = endLba >= startLba ? endLba - startLba + 1n : 0n;
    const sizeBytes = sizeSectors * BigInt(sectorSize);
    const sizeHuman = formatSize(sizeBytes);
    const attributeDesc = formatAttributeFlags(attributes);
    // Qualcomm "bootable" uses attribute bit 2 (legacy BIOS bootable)
    const bootable = (attributes & 4n) !== 0n;

    result.push({
      index: idx++,
      typeGuid,
      typeName,
      typeOs,
      uniqueGuid,
      startLba,
      endLba,
      sizeSectors,
      sizeBytes,
      sizeHuman,
      attributes,
      attributeDesc,
      name,
      bootable,
    });
  }

  return result;
}

/**
 * Generate hex dump of first N bytes.
 */
function hexDump(buf: Uint8Array, maxBytes = 512): string {
  const lines: string[] = [];
  const len = Math.min(maxBytes, buf.length);
  for (let i = 0; i < len; i += 16) {
    const row = buf.slice(i, Math.min(i + 16, len));
    const hex = Array.from(row).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(row).map(b => (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : ".").join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${ascii}|`);
  }
  return lines.join("\n");
}

/**
 * Main parse function.
 * Tries multiple sector sizes (512, 4096) and multiple file formats.
 */
export function parseGptImage(buf: ArrayBuffer): GptParseResult {
  const data = new Uint8Array(buf);
  const warnings: string[] = [];
  const errors: string[] = [];
  const fileSize = data.length;

  // Generate hex dump of start
  const dump = hexDump(data, Math.min(512, data.length));

  // Try to detect sector size and format
  // Possible GPT header locations (byte offset):
  //   Standard: 512 (MBR is 512B, header at LBA1)
  //   UFS 4K:   4096 (MBR is 4096B, header at LBA1)
  //   gpt_main: 0 (no MBR, starts directly at header) - sometimes
  //   gpt_both0 Qualcomm format (sgdisk -b backup):
  //     - Backup GPT: header at end, entries before it
  //     But when using mkgpt tool, gpt_both0.bin = primary (MBR+header+entries) + backup (entries+header)
  //     Primary part size = 512 + 512 + 32*512 = 17408 bytes (512-byte sectors)
  //     Or 4096 + 4096 + 4*4096 = 24576 bytes (4096-byte sectors)

  const SECTOR_SIZES = [512, 4096];
  // Offsets to search for "EFI PART" magic
  // We'll search exhaustively in the first 64KB and around the end of file
  const searchOffsets: number[] = [];

  // Common offsets for primary GPT
  for (const ss of SECTOR_SIZES) {
    searchOffsets.push(ss); // LBA 1 = 1 sector in
    searchOffsets.push(0);  // Sometimes file starts directly with header (no MBR)
  }

  // Also search the last 64KB for backup GPT
  const endSearchStart = Math.max(0, data.length - 65536);
  for (let o = endSearchStart; o < data.length - 8; o += 512) {
    searchOffsets.push(o);
  }

  // Remove duplicates and sort
  const uniqueOffsets = [...new Set(searchOffsets)].sort((a, b) => a - b);

  let primaryHeader: GptHeader | null = null;
  let backupHeader: GptHeader | null = null;
  let sectorSize = 512;
  let detectedFormat = "Unknown";

  // Find primary header (prefer lowest offset)
  for (const offset of uniqueOffsets) {
    if (offset < 0 || offset >= data.length) continue;
    if (!findMagicAt(data, offset)) continue;

    // Determine sector size from context
    let ss = 512;
    if (offset === 4096 || offset === 8192) ss = 4096;
    else if (offset === 512) ss = 512;
    else if (offset === 0) {
      // No MBR - figure out sector size from header CurrentLBA
      const currentLba = readUint64LE(data, offset + 0x18);
      if (currentLba === 0n) ss = 512; // unusual
      else if (currentLba === 1n) {
        // Could be either; try to infer from partition entry LBA
        const partLba = readUint64LE(data, offset + 0x48);
        ss = partLba === 2n ? 512 : 4096;
      }
    } else {
      // offset is a multiple of sector size
      if (offset % 4096 === 0) ss = 4096;
      else ss = 512;
    }

    const hdr = parseGptHeader(data, offset, ss);
    if (!hdr) continue;

    // Determine if primary or backup by looking at currentLba
    // Primary GPT header is at LBA 1, backup at last LBA
    if (primaryHeader === null) {
      // Accept as primary if currentLba <= 2 or it's at a low offset
      if (hdr.currentLba <= 2n || offset < data.length / 2) {
        primaryHeader = hdr;
        sectorSize = ss;
      }
    }
  }

  // Now search for backup header (near end of file or after primary data)
  if (primaryHeader) {
    // In gpt_both0.bin, backup comes right after the primary partition entries
    // Primary size = (2 + numEntries * entrySize / sectorSize) * sectorSize
    const primaryArraySectors = Math.ceil(
      (primaryHeader.numPartitionEntries * primaryHeader.partitionEntrySize) / sectorSize
    );
    const primaryTotalBytes = (2 + primaryArraySectors) * sectorSize; // MBR + header + entries

    // Try backup header at common locations
    const backupCandidates = [
      data.length - sectorSize,           // Last sector (standard backup GPT header location)
      primaryTotalBytes + primaryArraySectors * sectorSize, // After primary in gpt_both0
      primaryTotalBytes,                  // Right after primary
    ];

    // Also try searching near end
    for (let o = Math.max(0, data.length - 20 * sectorSize); o < data.length - 8; o += sectorSize) {
      backupCandidates.push(o);
    }

    for (const offset of backupCandidates) {
      if (offset < 0 || offset + 92 > data.length) continue;
      if (!findMagicAt(data, offset)) continue;
      if (offset === primaryHeader.offset) continue;

      const hdr = parseGptHeader(data, offset, sectorSize);
      if (hdr) {
        backupHeader = hdr;
        break;
      }
    }
  }

  // If still no primary, try scanning for any GPT magic
  if (!primaryHeader) {
    for (let offset = 0; offset < Math.min(data.length, 8192 * 2); offset += 512) {
      if (!findMagicAt(data, offset)) continue;
      const ss = offset >= 4096 ? 4096 : 512;
      const hdr = parseGptHeader(data, offset, ss);
      if (hdr) {
        primaryHeader = hdr;
        sectorSize = ss;
        break;
      }
    }
  }

  if (!primaryHeader) {
    errors.push(
      '未找到 GPT 头部（magic "EFI PART"）。' +
      '请确认文件是 GPT 格式（gpt_main0.bin / gpt_both0.bin / gpt_backup0.bin / 完整磁盘镜像）。'
    );
    return {
      fileSize,
      sectorSize: 512,
      detectedFormat: "Not a GPT image",
      primaryHeader: null,
      backupHeader: null,
      partitions: [],
      warnings,
      errors,
      hexDump: dump,
    };
  }

  // Detect format
  const headerOff = primaryHeader.offset;
  if (headerOff === 512) {
    detectedFormat = sectorSize === 512
      ? "Standard GPT (512B sectors, eMMC/SD)"
      : "GPT (512B offset)";
  } else if (headerOff === 4096) {
    detectedFormat = "Standard GPT (4096B sectors, UFS)";
  } else if (headerOff === 0) {
    detectedFormat = "GPT Header only (no Protective MBR)";
  } else {
    detectedFormat = `GPT at custom offset 0x${headerOff.toString(16)}`;
  }

  if (backupHeader) {
    detectedFormat += " + Backup GPT";
  }

  if (!primaryHeader.crcValid) {
    warnings.push("主 GPT 头部 CRC32 校验失败！数据可能已损坏。");
  }
  if (backupHeader && !backupHeader.crcValid) {
    warnings.push("备份 GPT 头部 CRC32 校验失败！");
  }

  // Parse partition entries
  // Entry array starts at partitionEntryLba * sectorSize, relative to start of disk image
  // But for standalone GPT files (not full disk), we need to be smarter.
  // For gpt_main0.bin: MBR is at 0, header at sectorSize, entries at 2*sectorSize
  // The partitionEntryLba in the header is the absolute LBA on disk (e.g., LBA 2)
  // For standalone files: entries are at offset headerOff + sectorSize (right after header)

  let entriesOffset: number;
  const partLba = primaryHeader.partitionEntryLba;

  // If this is a full disk image, entries are at partLba * sectorSize
  // If this is a standalone GPT file, entries are typically right after the header
  // Strategy: try partLba * sectorSize first, if that's within file bounds; else headerOff + sectorSize

  const lbaBasedOffset = Number(partLba) * sectorSize;
  if (lbaBasedOffset > 0 && lbaBasedOffset < data.length) {
    entriesOffset = lbaBasedOffset;
  } else {
    // Fallback: entries right after header sector
    entriesOffset = headerOff + sectorSize;
  }

  // For non-full-disk files (gpt_main0.bin etc.), if the header says partEntryLba=2
  // but the file starts with MBR at offset 0, then offset = 2 * sectorSize = 1024 (512B) or 8192 (4K)
  // This is correct.

  const entryCount = primaryHeader.numPartitionEntries;
  const entrySize = primaryHeader.partitionEntrySize;

  let partitions: GptPartitionEntry[] = [];

  if (entriesOffset + entryCount * entrySize <= data.length) {
    partitions = parsePartitionEntries(data, entriesOffset, entryCount, entrySize, sectorSize);

    // Validate partition array CRC
    const arraySize = entryCount * entrySize;
    const arrayCrc = crc32(data, entriesOffset, arraySize);
    if (arrayCrc !== primaryHeader.partitionArrayCrc32) {
      warnings.push(
        `分区表数组 CRC32 不匹配！期望 0x${primaryHeader.partitionArrayCrc32.toString(16).toUpperCase()}，` +
        `实际 0x${arrayCrc.toString(16).toUpperCase()}。`
      );
    }
  } else {
    warnings.push(
      `分区条目偏移量 0x${entriesOffset.toString(16)} 超出文件范围（文件大小 ${fileSize} 字节）。` +
      `可能是截断文件或非标准格式。`
    );
    // Try fallback: entries immediately after header
    const fallbackOffset = headerOff + sectorSize;
    if (fallbackOffset + entryCount * entrySize <= data.length) {
      partitions = parsePartitionEntries(data, fallbackOffset, entryCount, entrySize, sectorSize);
    }
  }

  if (partitions.length === 0) {
    warnings.push("未找到有效分区条目。");
  }

  return {
    fileSize,
    sectorSize,
    detectedFormat,
    primaryHeader,
    backupHeader,
    partitions,
    warnings,
    errors,
    hexDump: dump,
  };
}
