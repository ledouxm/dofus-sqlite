using System.IO.Compression;

// Minimal PNG encoder, so the tool doesn't need an imaging library
public static class Png
{
    // Input is BGRA with bottom-up rows (Unity's layout), output is an RGBA PNG
    public static byte[] EncodeBgraBottomUp(byte[] bgra, int width, int height)
    {
        int stride = width * 4;
        var rgba = new byte[stride * height];
        for (int y = 0; y < height; y++)
        {
            int src = (height - 1 - y) * stride;
            int dst = y * stride;
            for (int x = 0; x < width; x++, src += 4, dst += 4)
            {
                rgba[dst] = bgra[src + 2];
                rgba[dst + 1] = bgra[src + 1];
                rgba[dst + 2] = bgra[src];
                rgba[dst + 3] = bgra[src + 3];
            }
        }

        var filtered = FilterRows(rgba, stride, height);

        using var output = new MemoryStream();
        output.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

        var header = new byte[13];
        WriteUInt32BE(header, 0, (uint)width);
        WriteUInt32BE(header, 4, (uint)height);
        header[8] = 8; // bit depth
        header[9] = 6; // color type: RGBA
        WriteChunk(output, "IHDR", header);

        using (var compressed = new MemoryStream())
        {
            using (var zlib = new ZLibStream(compressed, CompressionLevel.Optimal, true))
            {
                zlib.Write(filtered);
            }
            WriteChunk(output, "IDAT", compressed.ToArray());
        }

        WriteChunk(output, "IEND", []);
        return output.ToArray();
    }

    // Picks the PNG filter that gives the smallest sum of absolute values for each row
    // (the libpng heuristic), which compresses far better than storing rows unfiltered
    private static byte[] FilterRows(byte[] pixels, int stride, int height)
    {
        const int bpp = 4;
        var result = new byte[(stride + 1) * height];
        var candidate = new byte[stride];
        var best = new byte[stride];

        for (int y = 0; y < height; y++)
        {
            int row = y * stride;
            int prev = row - stride;
            long bestScore = long.MaxValue;
            byte bestFilter = 0;

            for (byte filter = 0; filter <= 4; filter++)
            {
                long score = 0;
                for (int i = 0; i < stride; i++)
                {
                    int a = i >= bpp ? pixels[row + i - bpp] : 0;
                    int b = y > 0 ? pixels[prev + i] : 0;
                    int c = i >= bpp && y > 0 ? pixels[prev + i - bpp] : 0;
                    int predictor = filter switch
                    {
                        1 => a,
                        2 => b,
                        3 => (a + b) >> 1,
                        4 => Paeth(a, b, c),
                        _ => 0,
                    };
                    byte value = (byte)(pixels[row + i] - predictor);
                    candidate[i] = value;
                    score += value < 128 ? value : 256 - value;
                }

                if (score < bestScore)
                {
                    bestScore = score;
                    bestFilter = filter;
                    Array.Copy(candidate, best, stride);
                }
            }

            int dst = y * (stride + 1);
            result[dst] = bestFilter;
            Array.Copy(best, 0, result, dst + 1, stride);
        }

        return result;
    }

    private static int Paeth(int a, int b, int c)
    {
        int p = a + b - c;
        int pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        return pb <= pc ? b : c;
    }

    private static void WriteChunk(Stream stream, string type, byte[] data)
    {
        var typeAndData = new byte[4 + data.Length];
        for (int i = 0; i < 4; i++) typeAndData[i] = (byte)type[i];
        Array.Copy(data, 0, typeAndData, 4, data.Length);

        var length = new byte[4];
        WriteUInt32BE(length, 0, (uint)data.Length);
        var crc = new byte[4];
        WriteUInt32BE(crc, 0, Crc32(typeAndData));

        stream.Write(length);
        stream.Write(typeAndData);
        stream.Write(crc);
    }

    private static void WriteUInt32BE(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)(value >> 24);
        buffer[offset + 1] = (byte)(value >> 16);
        buffer[offset + 2] = (byte)(value >> 8);
        buffer[offset + 3] = (byte)value;
    }

    private static readonly uint[] CrcTable = Enumerable.Range(0, 256).Select(n =>
    {
        uint c = (uint)n;
        for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
        return c;
    }).ToArray();

    private static uint Crc32(byte[] data)
    {
        uint c = 0xFFFFFFFF;
        foreach (var b in data) c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFF;
    }
}
