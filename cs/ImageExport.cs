using System.IO.Compression;
using System.Text.RegularExpressions;
using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;
using SkiaSharp;

// Exports the textures of Picto/**/*.bundle as PNGs, one zip per category
// (item_assets_1x.bundle + item_assets_2x.bundle -> images-item.zip)
public static class ImageExport
{
    // Asset folders whose next segment is a grouping folder: "Assets/BuiltAssets/<category>/",
    // "Assets/UI/Themes/<theme>/" (uidarkstone_assets_all.bundle, worldmap hint icons)
    private static readonly string[] AssetRoots = ["Assets/BuiltAssets/", "Assets/UI/Themes/"];

    // Photographic categories are exported as lossy WebP: as PNGs, worldmap chunks weigh 0.5-2 MB each
    private static readonly HashSet<string> LossyCategories = ["worldmap"];
    private const int WebpQuality = 85;
    private const byte OpaqueAlpha = 250;

    // Textures are read in batches so huge bundles (worldmaps are ~1200 1024x1024 tiles)
    // never hold every decoded image in memory at once
    private const int BatchSize = 64;

    // Fixed timestamp so the same images produce the same zip
    private static readonly DateTimeOffset EntryTimestamp = new(2000, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static readonly Regex BundleNameRegex = new(@"^(?<category>.+?)_assets_(?<variant>[^.]*)\.bundle$");

    private record TextureEntry(long PathId, string ZipPath);

    public static void Run(string inputDir, string outputDir, string[] onlyCategories)
    {
        Directory.CreateDirectory(outputDir);

        var categories = Directory.GetFiles(inputDir, "*.bundle", SearchOption.AllDirectories)
            .Select(path => (path, match: BundleNameRegex.Match(Path.GetFileName(path))))
            .Where(bundle =>
            {
                if (!bundle.match.Success)
                {
                    Console.WriteLine($"Skipping {bundle.path}: unexpected bundle name");
                    return false;
                }
                return true;
            })
            .GroupBy(bundle => bundle.match.Groups["category"].Value)
            .Where(group => onlyCategories.Length == 0 || onlyCategories.Contains(group.Key))
            .OrderBy(group => group.Key, StringComparer.Ordinal);

        foreach (var category in categories)
        {
            var zipPath = Path.Combine(outputDir, $"images-{category.Key}.zip");
            var tempZipPath = zipPath + ".tmp";
            File.Delete(tempZipPath);

            int count = 0;
            using (var zip = ZipFile.Open(tempZipPath, ZipArchiveMode.Create))
            {
                var usedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var bundle in category.OrderBy(bundle => bundle.path, StringComparer.Ordinal))
                {
                    count += ExportBundle(bundle.path, bundle.match.Groups["variant"].Value, LossyCategories.Contains(category.Key), zip, usedPaths);
                }
            }

            File.Move(tempZipPath, zipPath, true);
            Console.WriteLine($"{Path.GetFileName(zipPath)}: {count} images, {new FileInfo(zipPath).Length / 1048576.0:F1} MB");
        }
    }

    private static int ExportBundle(string bundlePath, string variant, bool lossy, ZipArchive zip, HashSet<string> usedPaths)
    {
        var manager = new AssetsManager();
        try
        {
            var bundle = manager.LoadBundleFile(bundlePath, true);
            var assetsFile = manager.LoadAssetsFileFromBundle(bundle, 0, false);
            var catalogKeys = ReadCatalogKeys(bundlePath);
            var extension = lossy ? ".webp" : ".png";
            var entries = ResolveZipPaths(manager, assetsFile, variant, catalogKeys, extension, usedPaths, Path.GetFileName(bundlePath));

            foreach (var batch in entries.Chunk(BatchSize))
            {
                // AssetsManager isn't thread safe: read sequentially, decode and encode in parallel
                var textures = batch.Select(entry =>
                {
                    var texture = TextureFile.ReadTextureFile(manager.GetBaseField(assetsFile, assetsFile.file.GetAssetInfo(entry.PathId)));
                    return (entry, texture, data: texture.FillPictureData(assetsFile));
                }).ToArray();

                var pngs = new byte[textures.Length][];
                Parallel.For(0, textures.Length, i =>
                {
                    var (entry, texture, data) = textures[i];
                    var bgra = texture.DecodeTextureRaw(data);
                    if (bgra == null || bgra.Length != texture.m_Width * texture.m_Height * 4)
                    {
                        throw new InvalidDataException(
                            $"{Path.GetFileName(bundlePath)}: can't decode '{texture.m_Name}' ({(TextureFormat)texture.m_TextureFormat}, {texture.m_Width}x{texture.m_Height})");
                    }
                    pngs[i] = lossy
                        ? EncodeWebp(bgra, texture.m_Width, texture.m_Height)
                        : Png.EncodeBgraBottomUp(bgra, texture.m_Width, texture.m_Height);
                });

                for (int i = 0; i < textures.Length; i++)
                {
                    // PNGs and WebPs are already compressed, compressing them again only costs time
                    var zipEntry = zip.CreateEntry(textures[i].entry.ZipPath, CompressionLevel.NoCompression);
                    zipEntry.LastWriteTime = EntryTimestamp;
                    using var stream = zipEntry.Open();
                    stream.Write(pngs[i]);
                }
            }

            return entries.Count;
        }
        finally
        {
            manager.UnloadAll(true);
        }
    }

    // Input is BGRA with bottom-up rows (Unity's layout)
    private static byte[] EncodeWebp(byte[] bgra, int width, int height)
    {
        // Compressed textures store opaque pixels with an alpha of 254: kept, it would make the image
        // slightly see-through, so a nearly opaque image is encoded as an opaque one
        var opaque = true;
        for (int i = 3; i < bgra.Length && opaque; i += 4) opaque = bgra[i] >= OpaqueAlpha;
        // libwebp leaves the alpha channel out only when every pixel is fully opaque
        if (opaque) for (int i = 3; i < bgra.Length; i += 4) bgra[i] = 255;
        using var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Bgra8888, opaque ? SKAlphaType.Opaque : SKAlphaType.Unpremul));
        var pixels = bitmap.GetPixelSpan();
        int stride = width * 4;
        for (int y = 0; y < height; y++)
        {
            bgra.AsSpan((height - 1 - y) * stride, stride).CopyTo(pixels.Slice(y * stride, stride));
        }
        using var pixmap = bitmap.PeekPixels();
        using var webp = pixmap.Encode(new SKWebpEncoderOptions(SKWebpEncoderCompression.Lossy, WebpQuality))
            ?? throw new InvalidDataException($"Can't encode a {width}x{height} image as WebP");
        return webp.ToArray();
    }

    // Keys of the Addressables catalog shipped next to the bundle (Picto/Worldmaps/catalog_1.0.bin), by GUID
    private static Dictionary<string, string> ReadCatalogKeys(string bundlePath)
    {
        var catalogs = Directory.GetFiles(Path.GetDirectoryName(bundlePath)!, "catalog_*.bin");
        return catalogs
            .SelectMany(AddressablesCatalog.ReadKeysByInternalId)
            .GroupBy(entry => entry.Key)
            .ToDictionary(group => group.Key, group => group.First().Value);
    }

    // Prefers the original asset path ("Assets/BuiltAssets/emblems/big/up/1x/114.png" -> "big/up/1x/114.png",
    // "Assets/UI/Themes/darkStone/hints/10.png" -> "hints/10.png").
    // Some bundles only have GUIDs in their container: their catalog key is used instead
    // ("worldmaps/1/0.6/12.jpg" -> "1/0.6/12.webp"), else the texture name, suffixed with
    // its size (then an index) when several textures share a name
    private static List<TextureEntry> ResolveZipPaths(
        AssetsManager manager, AssetsFileInstance assetsFile, string variant, Dictionary<string, string> catalogKeys,
        string extension, HashSet<string> usedPaths, string bundleName)
    {
        var containerPaths = new Dictionary<long, string>();
        var assetBundles = assetsFile.file.GetAssetsOfType(AssetClassID.AssetBundle);
        if (assetBundles.Count > 0)
        {
            var assetBundle = manager.GetBaseField(assetsFile, assetBundles[0]);
            foreach (var entry in assetBundle["m_Container.Array"].Children)
            {
                containerPaths[entry["second.asset.m_PathID"].AsLong] = entry["first"].AsString;
            }
        }

        var textures = assetsFile.file.GetAssetsOfType(AssetClassID.Texture2D)
            .Select(info =>
            {
                var field = manager.GetBaseField(assetsFile, info);
                return (
                    pathId: info.PathId,
                    name: field["m_Name"].AsString,
                    size: $"{field["m_Width"].AsInt}x{field["m_Height"].AsInt}",
                    containerPath: containerPaths.GetValueOrDefault(info.PathId)
                );
            })
            .OrderBy(texture => texture.pathId)
            .ToList();

        // "1x"/"2x" bundles get a resolution folder, "all" and unsuffixed bundles don't
        var folder = Regex.IsMatch(variant, @"^\d+x$") ? variant + "/" : "";

        var nameCounts = textures.GroupBy(texture => texture.name).ToDictionary(group => group.Key, group => group.Count());
        var nameSizeCounts = textures.GroupBy(texture => (texture.name, texture.size)).ToDictionary(group => group.Key, group => group.Count());
        var nameSizeIndexes = new Dictionary<(string, string), int>();

        var entries = new List<TextureEntry>();
        foreach (var texture in textures)
        {
            string path;
            var root = AssetRoots.FirstOrDefault(root => texture.containerPath?.StartsWith(root, StringComparison.OrdinalIgnoreCase) == true);
            if (root != null)
            {
                // Drop the "Assets/BuiltAssets/<category>/" part
                var segments = texture.containerPath![root.Length..].Split('/');
                path = Path.ChangeExtension(string.Join('/', segments.Skip(1)), extension);
            }
            else if (texture.containerPath != null && catalogKeys.TryGetValue(texture.containerPath, out var key) && key.Contains('/'))
            {
                // Drop the "worldmaps/" part
                path = Path.ChangeExtension(key[(key.IndexOf('/') + 1)..], extension);
            }
            else
            {
                var name = SanitizeFileName(texture.name);
                if (nameCounts[texture.name] > 1)
                {
                    name += "_" + texture.size;
                    if (nameSizeCounts[(texture.name, texture.size)] > 1)
                    {
                        var index = nameSizeIndexes.GetValueOrDefault((texture.name, texture.size)) + 1;
                        nameSizeIndexes[(texture.name, texture.size)] = index;
                        name += "_" + index;
                    }
                }
                path = folder + name + extension;
            }

            if (!usedPaths.Add(path))
            {
                var deduplicated = Path.ChangeExtension(path, null) + "_" + texture.pathId + extension;
                Console.WriteLine($"Warning: {bundleName}: '{path}' already exists, writing '{deduplicated}' instead");
                usedPaths.Add(deduplicated);
                path = deduplicated;
            }

            entries.Add(new TextureEntry(texture.pathId, path));
        }

        return entries.OrderBy(entry => entry.ZipPath, StringComparer.Ordinal).ToList();
    }

    private static string SanitizeFileName(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "unnamed";
        var invalid = Path.GetInvalidFileNameChars().Concat(['/', '\\', ':', '*', '?', '"', '<', '>', '|']).ToHashSet();
        return new string(name.Trim().Select(c => invalid.Contains(c) ? '_' : c).ToArray());
    }
}
