// The COM objects never leave this dedicated STA. JavaScript only receives JSON.
// CorelDRAW is owned by the person using it: dispose releases references, never Quit().
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

public class Startup
{
    sealed class Job { public string Json; public TaskCompletionSource<object> Done = new TaskCompletionSource<object>(); }
    sealed class Document { public object Com; public int Revision; }
    readonly BlockingCollection<Job> queue = new BlockingCollection<Job>();
    readonly Dictionary<string, Document> documents = new Dictionary<string, Document>();
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16000000 };
    readonly Thread thread;
    object application;
    string progId = "CorelDRAW.Application";

    public Startup() {
        thread = new Thread(Run); thread.IsBackground = true; thread.Name = "dsh-coreldraw-STA";
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
    }
    public Task<object> Invoke(object input) {
        var job = new Job { Json = (string)input };
        if (queue.IsAddingCompleted) { job.Done.SetException(new InvalidOperationException("Bridge disposed")); return job.Done.Task; }
        queue.Add(job); return job.Done.Task;
    }
    void Run() {
        foreach (var job in queue.GetConsumingEnumerable()) {
            try {
                var args = json.Deserialize<Dictionary<string, object>>(job.Json);
                var result = Execute(args); result["ok"] = true;
                job.Done.SetResult(json.Serialize(result));
            } catch (Exception error) {
                job.Done.SetResult(json.Serialize(new { ok = false, error = error.Message, hresult = error.HResult, execution_state = "unknown", retryable = false }));
            }
        }
    }
    static Dictionary<string, object> Obj(params object[] pairs) {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) result[(string)pairs[i]] = pairs[i + 1];
        return result;
    }
    static string Text(Dictionary<string, object> args, string key, string fallback = "") { object v; return args.TryGetValue(key, out v) ? Convert.ToString(v, CultureInfo.InvariantCulture) : fallback; }
    static double Num(Dictionary<string, object> args, string key) { return Convert.ToDouble(args[key], CultureInfo.InvariantCulture); }
    static bool Flag(Dictionary<string, object> args, string key) { object v; return args.TryGetValue(key, out v) && Convert.ToBoolean(v); }
    static bool Same(object a, object b) {
        IntPtr x = Marshal.GetIUnknownForObject(a), y = Marshal.GetIUnknownForObject(b);
        try { return x == y; } finally { Marshal.Release(x); Marshal.Release(y); }
    }
    dynamic App(bool launch) {
        if (application != null) {
            try { var version = ((dynamic)application).Version; return application; }
            catch { application = null; documents.Clear(); }
        }
        try { application = Marshal.GetActiveObject(progId); }
        catch (COMException) {
            if (!launch) throw new InvalidOperationException("No running CorelDRAW COM instance. Open CorelDRAW or explicitly call corel_connect with launch:true.");
            var type = Type.GetTypeFromProgID(progId, true);
            application = Activator.CreateInstance(type);
            ((dynamic)application).Visible = true;
        }
        return application;
    }
    string Register(object doc) {
        foreach (var item in documents) if (Same(item.Value.Com, doc)) return item.Key;
        string id = Guid.NewGuid().ToString("N"); documents[id] = new Document { Com = doc }; return id;
    }
    Document Resolve(string id) {
        Document result;
        if (!documents.TryGetValue(id, out result)) throw new InvalidOperationException("Unknown document_id. List documents again.");
        dynamic app = App(false);
        for (int i = 1; i <= (int)app.Documents.Count; i++) if (Same(result.Com, (object)app.Documents[i])) return result;
        documents.Remove(id); throw new InvalidOperationException("Document is no longer open; no operation was applied to another document.");
    }
    Dictionary<string, object> Metadata(object value, string id) {
        dynamic doc = value;
        return Obj("document_id", id, "name", (string)doc.Name, "file_path", (string)doc.FilePath,
            "file_name", (string)doc.FileName, "pages", (int)doc.Pages.Count,
            "revision", documents[id].Revision);
    }
    string Fingerprint(object snapshot) {
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(json.Serialize(snapshot)))).Replace("-", "").ToLowerInvariant();
    }
    void Shapes(dynamic collection, double height, List<object> result, int depth) {
        if (depth > 32) throw new InvalidOperationException("Shape nesting exceeds inspection limit");
        for (int i = 1; i <= (int)collection.Count; i++) {
            if (result.Count >= 5000) throw new InvalidOperationException("Page exceeds 5000 shape inspection limit");
            dynamic s = collection[i]; double w = (double)s.SizeWidth, h = (double)s.SizeHeight;
            var row = Obj("shape_id", Convert.ToString(s.StaticID), "name", (string)s.Name, "type", (int)s.Type,
                "x", (double)s.LeftX, "y", height - (double)s.TopY, "width", w, "height", h,
                "rotation", (double)s.RotationAngle, "locked", (bool)s.Locked);
            if ((int)s.Type == 6) { row["text"] = (string)s.Text.Story.Text; }
            // Colour models differ between documents; ToString is not a colour value.
            try { row["fill_type"] = (int)s.Fill.Type; row["fill_rgb"] = (int)s.Fill.UniformColor.RGBValue; } catch { }
            result.Add(row);
            if ((int)s.Type == 7) Shapes(s.Shapes, height, result, depth + 1);
        }
    }
    Dictionary<string, object> Snapshot(Document state, string id) {
        dynamic doc = state.Com; dynamic page = doc.ActivePage;
        int oldUnit = (int)doc.Unit, oldReference = (int)doc.ReferencePoint;
        try {
            doc.Unit = 3; doc.ReferencePoint = 1;
            var shapes = new List<object>(); Shapes(page.Shapes, (double)page.SizeHeight, shapes, 0);
            var content = Obj("page", (int)page.Index, "width", (double)page.SizeWidth, "height", (double)page.SizeHeight, "shapes", shapes);
            var result = Metadata(state.Com, id); result["page"] = content; result["unit"] = "mm";
            result["coordinates"] = "page_top_left"; result["snapshot_token"] = Fingerprint(content);
            return result;
        } finally { doc.ReferencePoint = oldReference; doc.Unit = oldUnit; }
    }
    object FindShape(dynamic shapes, string id) {
        for (int i = 1; i <= (int)shapes.Count; i++) {
            dynamic shape = shapes[i];
            if (Convert.ToString(shape.StaticID) == id) return shape;
            if ((int)shape.Type == 7) { object found = FindShape(shape.Shapes, id); if (found != null) return found; }
        }
        return null;
    }
    void ValidateSnapshot(Document state, string id, Dictionary<string, object> args) {
        var current = Snapshot(state, id);
        if (Text(args, "snapshot_token") != (string)current["snapshot_token"] || Num(args, "expected_revision") != state.Revision)
            throw new InvalidOperationException("Document changed since inspection. Inspect again before editing; nothing was applied.");
    }
    object Operation(dynamic doc, Dictionary<string, object> op) {
        string action = Text(op, "op"); dynamic page = doc.ActivePage; double pageHeight = (double)page.SizeHeight;
        dynamic shape = null;
        if (op.ContainsKey("shape_id")) {
            shape = FindShape(page.Shapes, Text(op, "shape_id"));
            if (shape == null) throw new InvalidOperationException("Shape no longer exists: " + Text(op, "shape_id"));
            if ((bool)shape.Locked) throw new InvalidOperationException("Shape is locked");
        }
        if (action == "rectangle") {
            double x = Num(op, "x"), top = pageHeight - Num(op, "y"), w = Num(op, "width"), h = Num(op, "height");
            shape = page.ActiveLayer.CreateRectangle(x, top - h, x + w, top, 0, 0, 0, 0);
        } else if (action == "ellipse") {
            double x = Num(op, "x"), top = pageHeight - Num(op, "y"), w = Num(op, "width"), h = Num(op, "height");
            shape = page.ActiveLayer.CreateEllipse(x, top - h, x + w, top);
        } else if (action == "text") {
            double x = Num(op, "x"), top = pageHeight - Num(op, "y");
            shape = page.ActiveLayer.CreateParagraphText(x, top, x + Num(op, "width"), top - Num(op, "height"), Text(op, "text"));
            if (op.ContainsKey("font")) shape.Text.Story.Font = Text(op, "font");
            if (op.ContainsKey("font_size")) shape.Text.Story.Size = Num(op, "font_size");
        } else if (action == "set_text") shape.Text.Story.Text = Text(op, "text");
        else if (action == "move") shape.Move(Num(op, "x") - (double)shape.LeftX, pageHeight - Num(op, "y") - (double)shape.TopY);
        else if (action == "resize") {
            // Bounds properties are independent of the document reference point.
            double left = (double)shape.LeftX, top = (double)shape.TopY;
            shape.SetSize(Num(op, "width"), Num(op, "height"));
            shape.Move(left - (double)shape.LeftX, top - (double)shape.TopY);
        }
        else if (action == "rotate") shape.Rotate(Num(op, "angle") - (double)shape.RotationAngle);
        else if (action == "delete") { string sid = Convert.ToString(shape.StaticID); shape.Delete(); return Obj("op", action, "shape_id", sid); }
        else if (action != "fill") throw new InvalidOperationException("Unsupported operation " + action);
        if (op.ContainsKey("name")) shape.Name = Text(op, "name");
        if (op.ContainsKey("rgb")) {
            var rgb = (ArrayList)op["rgb"];
            dynamic color = App(false).CreateRGBColor(Convert.ToInt32(rgb[0]), Convert.ToInt32(rgb[1]), Convert.ToInt32(rgb[2]));
            shape.Fill.ApplyUniformFill(color);
        }
        return Obj("op", action, "shape_id", Convert.ToString(shape.StaticID));
    }
    Dictionary<string, object> Execute(Dictionary<string, object> args) {
        string action = Text(args, "action");
        if (action == "doctor") return Obj("apartment", Thread.CurrentThread.GetApartmentState().ToString(), "clr", Environment.Version.ToString(), "thread_id", Thread.CurrentThread.ManagedThreadId);
        if (action == "dispose") { documents.Clear(); application = null; queue.CompleteAdding(); return Obj("disposed", true); }
        if (action == "connect") {
            string requested = Text(args, "prog_id", progId);
            if (requested != progId) { documents.Clear(); application = null; progId = requested; }
            dynamic connected = App(Flag(args, "launch"));
            return Obj("version", Convert.ToString(connected.Version), "prog_id", progId, "document_count", (int)connected.Documents.Count);
        }
        dynamic app = App(false);
        if (action == "documents") {
            var rows = new List<object>();
            for (int i = 1; i <= (int)app.Documents.Count; i++) { object doc = app.Documents[i]; string id = Register(doc); rows.Add(Metadata(doc, id)); }
            return Obj("version", Convert.ToString(app.Version), "documents", rows);
        }
        if (action == "create") {
            dynamic doc = app.CreateDocument(); string id = Register((object)doc);
            doc.Unit = 3; doc.ActivePage.SetSize(Num(args, "width"), Num(args, "height"));
            return Snapshot(documents[id], id);
        }
        string documentId = Text(args, "document_id"); Document state = Resolve(documentId); dynamic document = state.Com;
        if (action == "inspect") return Snapshot(state, documentId);
        if (action == "apply") {
            ValidateSnapshot(state, documentId, args);
            int oldUnit = (int)document.Unit, oldReference = (int)document.ReferencePoint;
            bool started = false; var results = new List<object>();
            try {
                document.Unit = 3; document.ReferencePoint = 1;
                document.BeginCommandGroup(Text(args, "label", "dsh-coreldraw edit")); started = true;
                foreach (Dictionary<string, object> op in (ArrayList)args["operations"]) results.Add(Operation(document, op));
                document.EndCommandGroup(); started = false; state.Revision++;
            } catch (Exception error) {
                // Do not claim ACID guarantees: if rollback itself fails the outcome is unknown.
                if (started) {
                    try {
                        document.EndCommandGroup();
                        // Corel may omit an empty undo group. Never call Undo on
                        // an unchanged document and accidentally undo a prior edit.
                        if ((string)Snapshot(state, documentId)["snapshot_token"] != Text(args, "snapshot_token")) document.Undo();
                    }
                    catch (Exception rollback) { throw new InvalidOperationException(error.Message + "; rollback failed: " + rollback.Message); }
                }
                state.Revision++; throw;
            } finally { document.ReferencePoint = oldReference; document.Unit = oldUnit; }
            var result = Snapshot(state, documentId); result["operations"] = results; return result;
        }
        if (action == "undo") {
            ValidateSnapshot(state, documentId, args); document.Undo(); state.Revision++; return Snapshot(state, documentId);
        }
        if (action == "save" || action == "export") {
            string path = Text(args, "path");
            if (File.Exists(path) && !Flag(args, "overwrite")) throw new IOException("Destination exists; explicitly pass overwrite:true");
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            if (action == "save") {
                dynamic options = app.CreateStructSaveAsOptions();
                document.SaveAs(path, options);
            }
            else {
                string format = Text(args, "format");
                if (format == "pdf") document.PublishToPDF(path);
                else {
                    // ExportEx returns an export filter; Finish commits it synchronously.
                    int filter = format == "svg" ? 1345 : 802;
                    dynamic options = app.CreateStructExportOptions();
                    dynamic palette = app.CreateStructPaletteOptions();
                    dynamic exporter = document.ExportEx(path, filter, 1, options, palette); exporter.Finish();
                }
            }
            var file = new FileInfo(path); if (!file.Exists || file.Length == 0) throw new IOException("CorelDRAW did not produce a nonempty output file");
            return Obj("document_id", documentId, "path", path, "bytes", file.Length);
        }
        throw new InvalidOperationException("Unknown action: " + action);
    }
}
