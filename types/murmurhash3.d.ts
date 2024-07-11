declare module 'murmurhash3' {
  /** return 32bit integer value */
  export function murmur32Sync(key: string, seed?: number): number;
  /** return 32bit hexadecimal string */
  export function murmur32HexSync(key: string, seed?: number): string;
  /** return array that have 4 elements of 32bit integer */
  export function murmur128Sync(key: string, seed?: number): number[];
  /** return 128bit hexadecimal string */
  export function murmur128HexSync(key: string, seed?: number): string;
}
