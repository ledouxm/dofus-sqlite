using System.Text;

// Reads the keys of an Addressables binary catalog (catalog_1.0.bin, format 2).
// Bundles like worldmaps only have GUIDs in their container: the catalog is what maps
// each GUID (a location's internal id) to its addressable key ("worldmaps/1/0.6/12.jpg")
public static class AddressablesCatalog
{
    private const uint Magic = 0x0DE38942;
    private const uint UnicodeFlag = 0x80000000;
    private const uint DynamicFlag = 0x40000000;
    private const uint OffsetMask = 0x3FFFFFFF;
    private const uint Null = uint.MaxValue;

    // Internal id -> primary key, for every location of the catalog
    public static Dictionary<string, string> ReadKeysByInternalId(string catalogPath)
    {
        var data = File.ReadAllBytes(catalogPath);
        uint U32(uint offset) => BitConverter.ToUInt32(data, checked((int)offset));

        if (U32(0) != Magic) throw new InvalidDataException($"{catalogPath}: not a binary Addressables catalog");
        if (U32(4) != 2) throw new InvalidDataException($"{catalogPath}: unsupported catalog version {U32(4)}");

        // Strings are stored after their byte length. Dynamic strings are linked lists of parts
        // ({part, next}), stored last part first and joined with '/'
        string ReadString(uint id)
        {
            if (id == Null) return "";
            if ((id & DynamicFlag) != 0)
            {
                var parts = new List<string>();
                for (var node = id & OffsetMask; node != Null; node = U32(node + 4))
                {
                    parts.Add(ReadString(U32(node)));
                }
                parts.Reverse();
                return string.Join('/', parts);
            }
            var offset = id & OffsetMask;
            var length = (int)U32(offset - 4);
            var encoding = (id & UnicodeFlag) != 0 ? Encoding.Unicode : Encoding.ASCII;
            return encoding.GetString(data, (int)offset, length);
        }

        // Header: magic, version, keys, ...; keys is an array of {key object, location set},
        // a location set an array of locations: {primary key, internal id, provider, ...}
        var keys = U32(8);
        var result = new Dictionary<string, string>();
        for (uint entry = keys; entry < keys + U32(keys - 4); entry += 8)
        {
            var locations = U32(entry + 4);
            for (uint location = locations; location < locations + U32(locations - 4); location += 4)
            {
                var fields = U32(location);
                result.TryAdd(ReadString(U32(fields + 4)), ReadString(U32(fields)));
            }
        }
        return result;
    }
}
