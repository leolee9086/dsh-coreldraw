// Reusable asset export. All artwork, names, paths and instance choices come from callers.
// This partial class shares the existing serialized STA and document identity registry.
public partial class Startup
{
    void IndexAssets(dynamic shapes, System.Collections.Generic.Dictionary<string, object> index, System.Collections.Generic.Dictionary<string, string> parents, string parent, int depth) {
        if (depth > 32) throw new System.InvalidOperationException("Shape nesting exceeds 32 levels");
        for (int i = 1; i <= (int)shapes.Count; i++) {
            if (index.Count >= 100000) throw new System.InvalidOperationException("Asset lookup exceeds 100000 shapes");
            dynamic shape = shapes[i]; string id = System.Convert.ToString(shape.StaticID);
            index.Add(id, (object)shape); parents.Add(id, parent);
            if ((int)shape.Type == 7) IndexAssets(shape.Shapes, index, parents, id, depth + 1);
        }
    }
    System.Collections.Generic.Dictionary<string, object> ExportAssets(Document state, string documentId, System.Collections.Generic.Dictionary<string, object> args) {
        dynamic app = App(false), doc = state.Com;
        int pageNumber = args.ContainsKey("page") ? System.Convert.ToInt32(args["page"]) : (int)doc.ActivePage.Index;
        var assets = (System.Collections.ArrayList)args["assets"];
        bool dry = Flag(args, "dry_run"), overwrite = Flag(args, "overwrite");
        string outputDir = Text(args, "output_dir"), reportPath = Text(args, "report_path");
        double ox = 0, oy = 0;
        if (args.ContainsKey("origin")) { var origin = (System.Collections.Generic.Dictionary<string, object>)args["origin"]; ox = Num(origin, "x"); oy = Num(origin, "y"); }
        var index = new System.Collections.Generic.Dictionary<string, object>();
        var parents = new System.Collections.Generic.Dictionary<string, string>();
        IndexAssets(doc.Pages[pageNumber].Shapes, index, parents, "", 0);
        // Validate the entire request before the first output. Never discover a collision halfway through.
        foreach (System.Collections.Generic.Dictionary<string, object> asset in assets) {
            var ids = new System.Collections.Generic.HashSet<string>();
            foreach (object raw in (System.Collections.ArrayList)asset["shape_ids"]) {
                string id = System.Convert.ToString(raw);
                if (!index.ContainsKey(id)) throw new System.InvalidOperationException("Unknown shape " + id);
                if (!ids.Add(id)) throw new System.InvalidOperationException("Duplicate shape " + id);
            }
            foreach (string id in ids) {
                string ancestor = parents[id];
                while (ancestor != "") {
                    if (ids.Contains(ancestor)) throw new System.InvalidOperationException("Selection contains both a group and its child: " + id);
                    ancestor = parents[ancestor];
                }
            }
            foreach (string format in (System.Collections.ArrayList)asset["formats"]) {
                string destination = System.IO.Path.Combine(outputDir, Text(asset, "name") + "." + format);
                if (System.IO.File.Exists(destination) && !overwrite) throw new System.IO.IOException("Destination exists: " + destination);
            }
        }
        if (reportPath != "" && System.IO.File.Exists(reportPath) && !overwrite) throw new System.IO.IOException("Report exists: " + reportPath);
        object previousDocument = app.ActiveDocument;
        int oldPage = (int)doc.ActivePage.Index, oldUnit = (int)doc.Unit;
        dynamic previousSelection = doc.SelectionRange;
        var reports = new System.Collections.Generic.List<object>();
        var result = Obj("document_id", documentId, "document_path", System.Convert.ToString(doc.FullFileName), "page", pageNumber,
            "unit", "mm", "coordinates", "page_top_left", "origin", Obj("x", ox, "y", oy), "dry_run", dry, "complete", false, "assets", reports);
        bool journalWritten = false;
        System.Action journal = () => {
            if (dry || reportPath == "") return;
            WriteJsonOutput(reportPath, json.Serialize(result), overwrite || journalWritten);
            journalWritten = true;
        };
        try {
            // Establish a readable incomplete report before producing any files.
            journal();
            doc.Activate(); doc.Pages[pageNumber].Activate(); doc.Unit = 3;
            double ph = (double)doc.ActivePage.SizeHeight;
            foreach (System.Collections.Generic.Dictionary<string, object> asset in assets) {
                string name = Text(asset, "name"); dynamic range = app.CreateShapeRange();
                var ids = new System.Collections.Generic.HashSet<string>();
                foreach (object raw in (System.Collections.ArrayList)asset["shape_ids"]) { string id = System.Convert.ToString(raw); ids.Add(id); range.Add(index[id]); }
                range.CreateSelection(); dynamic selection = doc.SelectionRange;
                if ((int)selection.Count != ids.Count) throw new System.InvalidOperationException("Selection count mismatch: " + name);
                for (int i = 1; i <= (int)selection.Count; i++) if (!ids.Contains(System.Convert.ToString(selection[i].StaticID))) throw new System.InvalidOperationException("Unexpected selection member: " + name);
                double x = (double)range.LeftX, y = ph - (double)range.TopY, w = (double)range.SizeWidth, h = (double)range.SizeHeight;
                // Corel's geometric box excludes outlines. Painted bounds prevent clipped strokes.
                double px = 0, py = 0, pw = 0, pheight = 0;
                range.GetBoundingBox(out px, out py, out pw, out pheight, true); py = ph - py - pheight;
                double rx = px, ry = py, rw = pw, rh = pheight;
                if (asset.ContainsKey("crop")) {
                    var crop = (System.Collections.Generic.Dictionary<string, object>)asset["crop"];
                    rx = Num(crop, "x"); ry = Num(crop, "y"); rw = Num(crop, "width"); rh = Num(crop, "height");
                }
                if (rw <= 0 || rh <= 0) throw new System.InvalidOperationException("Empty export rectangle: " + name);
                var files = new System.Collections.Generic.List<object>();
                var row = Obj("name", name, "source_ids", asset["shape_ids"],
                    "source_mm", Obj("x", x, "y", y, "width", w, "height", h),
                    "board_mm", Obj("x", x-ox, "y", y-oy, "width", w, "height", h),
                    "painted_source_mm", Obj("x", px, "y", py, "width", pw, "height", pheight),
                    "raster_source_mm", Obj("x", rx, "y", ry, "width", rw, "height", rh),
                    "raster_board_mm", Obj("x", rx-ox, "y", ry-oy, "width", rw, "height", rh), "files", files);
                reports.Add(row);
                foreach (string format in (System.Collections.ArrayList)asset["formats"]) {
                    string destination = System.IO.Path.Combine(outputDir, name + "." + format);
                    int dpi = asset.ContainsKey("dpi") ? System.Convert.ToInt32(asset["dpi"]) : 96;
                    var file = Obj("path", destination, "format", format);
                    if (format == "png") file["dpi"] = dpi;
                    if (!dry) {
                        // Recheck just before COM writes: an earlier asset can take
                        // long enough for another process to create this destination.
                        if (!overwrite && System.IO.File.Exists(destination)) throw new System.IO.IOException("Destination exists: " + destination);
                        System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(destination));
                        dynamic palette = app.CreateStructPaletteOptions();
                        if (format == "png") {
                            dynamic rectangle = app.CreateRect(rx, ph-ry-rh, rw, rh);
                            // Full 16 arguments are necessary on CorelDRAW 24. Selection + alpha + explicit region.
                            dynamic filter = doc.ExportBitmap(destination, 802, 2, 4, 0, 0, dpi, dpi, 1, false, true, false, false, 0, palette, rectangle);
                            filter.Finish();
                        } else {
                            dynamic options = app.CreateStructExportOptions();
                            dynamic filter = doc.ExportEx(destination, 1345, 2, options, palette); filter.Finish();
                        }
                        var info = new System.IO.FileInfo(destination);
                        if (!info.Exists || info.Length == 0) throw new System.IO.IOException("Empty export: " + destination);
                        file["bytes"] = info.Length;
                    }
                    files.Add(file); journal();
                }
            }
            result["complete"] = true; journal(); return result;
        } catch (System.Exception error) {
            result["complete"] = false; result["error"] = error.Message;
            string journalError = "";
            try { journal(); } catch (System.Exception reportError) { journalError = "; could not update report: " + reportError.Message; }
            throw new System.InvalidOperationException(error.Message + journalError + (reportPath == "" ? "; completed output: " + json.Serialize(reports) : "; inspect partial report and existing files: " + reportPath), error);
        } finally {
            // Attempt every restoration even if one COM property has failed.
            // A restoration failure is visible to callers, never a silent success.
            var restoreErrors = new System.Collections.Generic.List<string>();
            System.Action<string, System.Action> restore = (label, action) => {
                try { action(); } catch (System.Exception error) { restoreErrors.Add(label + ": " + error.Message); }
            };
            restore("clear selection", () => { doc.ClearSelection(); });
            restore("page", () => { doc.Pages[oldPage].Activate(); });
            restore("unit", () => { doc.Unit = oldUnit; });
            restore("selection", () => { if ((int)previousSelection.Count > 0) previousSelection.CreateSelection(); });
            restore("active document", () => { ((dynamic)previousDocument).Activate(); });
            if (restoreErrors.Count > 0) {
                result["complete"] = false; result["restoration_errors"] = restoreErrors;
                try { journal(); } catch (System.Exception error) { restoreErrors.Add("report: " + error.Message); }
                throw new System.InvalidOperationException("Export state restoration failed: " + string.Join("; ", restoreErrors) + "; prior error: " + Text(result, "error") + "; inspect outputs: " + reportPath);
            }
        }
    }
}
