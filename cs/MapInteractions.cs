using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using AssetsTools.NET;
using AssetsTools.NET.Extra;

// Extracts interactive elements from Map/Data/mapdata_assets_world_*.bundle.
// Dumping these bundles to JSON is slow (they're mostly shader parameters), so only the
// interactive element references are read, bundles in parallel
public static class MapInteractions
{
    // 3.7 renamed the class and its interaction id field; bundles that weren't rebuilt keep the old names
    private static readonly Dictionary<string, string> InteractionIdFieldByClass = new()
    {
        ["ClientInteractiveAnimatedElementTransform"] = "m_interactionId",
        ["ClientInteractiveMapAnimatedElement"] = "<interactiveId>k__BackingField",
    };

    private static readonly Regex BundleNameRegex = new(@"^mapdata_assets_world_(?<world>\d+)\.bundle$");
    private static readonly Regex FirstNumberRegex = new(@"\d+");

    private record Row(long? MapId, long WorldId, long? GfxId, long? CellId, long? InteractionId);

    public static void Run(string inputDir, string outputJsonPath)
    {
        var bundles = Directory.GetFiles(inputDir)
            .Select(path => (path, match: BundleNameRegex.Match(Path.GetFileName(path))))
            .Where(bundle => bundle.match.Success)
            .ToList();

        Console.WriteLine($"Reading {bundles.Count} map bundles");

        var rowsByBundle = new ConcurrentDictionary<string, List<Row>>();
        // Each parsed bundle can take a few hundred MB: cap the parallelism to bound memory
        var options = new ParallelOptions { MaxDegreeOfParallelism = Math.Min(Environment.ProcessorCount, 8) };
        Parallel.ForEach(bundles, options, bundle =>
        {
            var worldId = long.Parse(bundle.match.Groups["world"].Value);
            rowsByBundle[bundle.path] = ReadBundle(bundle.path, worldId);
        });

        // Bundle order, then the order of the references inside each bundle, like the JSON based export
        var rows = bundles
            .OrderBy(bundle => bundle.path, StringComparer.Ordinal)
            .SelectMany(bundle => rowsByBundle[bundle.path])
            .ToList();

        var outputDir = Path.GetDirectoryName(Path.GetFullPath(outputJsonPath));
        if (outputDir != null) Directory.CreateDirectory(outputDir);

        using var stream = File.Create(outputJsonPath);
        using var writer = new Utf8JsonWriter(stream);
        writer.WriteStartArray();
        foreach (var row in rows)
        {
            writer.WriteStartObject();
            WriteNullable(writer, "mapId", row.MapId);
            writer.WriteNumber("worldId", row.WorldId);
            WriteNullable(writer, "gfxId", row.GfxId);
            WriteNullable(writer, "cellId", row.CellId);
            WriteNullable(writer, "interactionId", row.InteractionId);
            writer.WriteEndObject();
        }
        writer.WriteEndArray();

        Console.WriteLine($"Wrote {rows.Count} interactions to {outputJsonPath}");
    }

    private static List<Row> ReadBundle(string bundlePath, long worldId)
    {
        var manager = new AssetsManager
        {
            // Every MonoBehaviour of a bundle shares the same types
            UseTemplateFieldCache = true,
            UseRefTypeManagerCache = true,
            UseMonoTemplateFieldCache = true,
        };

        try
        {
            var bundle = manager.LoadBundleFile(bundlePath, true);
            var assetsFile = manager.LoadAssetsFileFromBundle(bundle, 0, false);
            var rows = new List<Row>();

            foreach (var mono in assetsFile.file.GetAssetsOfType(AssetClassID.MonoBehaviour))
            {
                var baseField = manager.GetBaseField(assetsFile, mono);
                var registry = baseField["references"]?.Value?.AsManagedReferencesRegistry;
                if (registry == null) continue;

                var nameMatch = FirstNumberRegex.Match(baseField["m_Name"]?.AsString ?? "");
                long? mapId = nameMatch.Success ? long.Parse(nameMatch.Value) : null;

                foreach (var reference in registry.references)
                {
                    if (reference.data == null
                        || !InteractionIdFieldByClass.TryGetValue(reference.type.ClassName, out var interactionIdField)) continue;

                    rows.Add(new Row(
                        mapId,
                        worldId,
                        ReadInteger(reference.data, "gfxId"),
                        ReadInteger(reference.data, "cellId"),
                        ReadInteger(reference.data, interactionIdField)));
                }
            }

            return rows;
        }
        finally
        {
            manager.UnloadAll(true);
        }
    }

    private static long? ReadInteger(AssetTypeValueField data, string fieldName)
    {
        var field = data.Children.FirstOrDefault(child => child.FieldName == fieldName);
        if (field?.Value == null) return null;

        return field.Value.ValueType switch
        {
            AssetValueType.Int8 or AssetValueType.Int16 or AssetValueType.Int32 => field.AsInt,
            AssetValueType.UInt8 or AssetValueType.UInt16 or AssetValueType.UInt32 => field.AsUInt,
            AssetValueType.Int64 => field.AsLong,
            AssetValueType.UInt64 => (long)field.AsULong,
            _ => throw new InvalidDataException($"{fieldName} has unexpected type {field.Value.ValueType}"),
        };
    }

    private static void WriteNullable(Utf8JsonWriter writer, string name, long? value)
    {
        if (value.HasValue) writer.WriteNumber(name, value.Value);
        else writer.WriteNull(name);
    }
}
