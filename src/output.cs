// Publish complete JSON files only. A failed serialization/write must leave the
// previous catalogue or progress journal readable. The staging file is on the
// same volume so Move/Replace does not degrade into a copy across filesystems.
public partial class Startup
{
    void WriteJsonOutput(string destination, string content, bool overwrite) {
        string directory = System.IO.Path.GetDirectoryName(destination);
        System.IO.Directory.CreateDirectory(directory);
        string temporary = System.IO.Path.Combine(directory, ".dsh-corel-" + System.Guid.NewGuid().ToString("N") + ".tmp");
        try {
            using (var stream = new System.IO.FileStream(temporary, System.IO.FileMode.CreateNew, System.IO.FileAccess.Write))
            using (var writer = new System.IO.StreamWriter(stream, new System.Text.UTF8Encoding(false))) {
                writer.Write(content);
            }
            // Move refuses a destination created after preflight. Never remove the
            // old file first: Replace keeps it intact if replacement cannot finish.
            if (overwrite && System.IO.File.Exists(destination))
                System.IO.File.Replace(temporary, destination, null);
            else
                System.IO.File.Move(temporary, destination);
        } finally {
            if (System.IO.File.Exists(temporary)) System.IO.File.Delete(temporary);
        }
    }
}
