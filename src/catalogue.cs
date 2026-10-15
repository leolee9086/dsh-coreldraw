// Whole-page catalogue export. The complete nested index goes to a JSON file;
// the tool reply contains only a summary. Shares the serialized STA and document
// registry with the other bridge actions. PowerClip contents are not traversed.
public partial class Startup
{
    System.Collections.Generic.Dictionary<string, object> CatalogueRow(dynamic shape, double pageHeight, double factor, int index, bool includeText, int depth, int[] total, int maxShapes) {
        if (++total[0] > maxShapes) throw new System.InvalidOperationException("Catalogue exceeds " + maxShapes + " shapes");
        int type = (int)shape.Type;
        var row = Obj("index", index, "id", System.Convert.ToString(shape.StaticID), "type", type, "name", (string)shape.Name,
            "x", (double)shape.LeftX * factor, "y", pageHeight - (double)shape.TopY * factor,
            "w", (double)shape.SizeWidth * factor, "h", (double)shape.SizeHeight * factor);
        // UniformColor is meaningful only for a uniform fill. Gradients and
        // groups must not acquire a plausible but unrelated uniform colour.
        try {
            int fillType = (int)shape.Fill.Type;
            row["fill_type"] = System.Convert.ToString(fillType);
            if (fillType == 1) row["fill_hex"] = System.Convert.ToString(shape.Fill.UniformColor.HexValue);
        } catch (System.Exception error) { row["fill_error"] = error.Message; }
        if (type == 6 && includeText) {
            string text = (string)shape.Text.Story.Text;
            row["text"] = text.Length > 4000 ? text.Substring(0, 4000) : text;
            row["text_truncated"] = text.Length > 4000;
        }
        if (type == 7) {
            int count = (int)shape.Shapes.Count;
            // A truncated group must never be reported as a complete catalogue.
            if (depth == 0 && count > 0) throw new System.InvalidOperationException("Catalogue nesting exceeds 32 levels");
            var children = new System.Collections.Generic.List<object>();
            for (int i = 1; i <= count; i++)
                children.Add(CatalogueRow(shape.Shapes[i], pageHeight, factor, i, includeText, depth - 1, total, maxShapes));
            row["children"] = children;
        }
        return row;
    }
    System.Collections.Generic.Dictionary<string, object> ExportCatalogue(Document state, string documentId, System.Collections.Generic.Dictionary<string, object> args) {
        dynamic doc = state.Com;
        string destination = Text(args, "path");
        bool overwrite = Flag(args, "overwrite");
        if (System.IO.File.Exists(destination) && !overwrite) throw new System.IO.IOException("Destination exists: " + destination);
        bool includeText = Flag(args, "include_text");
        int maxShapes = args.ContainsKey("max_shapes") ? System.Convert.ToInt32(args["max_shapes"]) : 100000;
        int pageNumber = args.ContainsKey("page") ? System.Convert.ToInt32(args["page"]) : (int)doc.ActivePage.Index;
        var rows = new System.Collections.Generic.List<object>(); var total = new int[1];
        int unit = (int)doc.Unit;
        // Convert the returned values, not the document. Reading a catalogue
        // must not change units, active page, selection or document dirty state.
        double factor = (double)App(false).ConvertUnits(1.0, unit, 3);
        dynamic page = doc.Pages[pageNumber];
        double pageWidth = (double)page.SizeWidth * factor, pageHeight = (double)page.SizeHeight * factor;
        int countBefore = (int)page.Shapes.Count;
        for (int i = 1; i <= countBefore; i++)
            rows.Add(CatalogueRow(page.Shapes[i], pageHeight, factor, i, includeText, 32, total, maxShapes));
        if ((int)doc.Unit != unit || (int)page.Shapes.Count != countBefore)
            throw new System.InvalidOperationException("Document changed while reading the catalogue; inspect again");
        string documentPath = System.Convert.ToString(doc.FullFileName);
        var payload = Obj("summary", Obj("document", documentPath, "page", pageNumber, "total", total[0], "top_level", rows.Count,
            "page_width_mm", pageWidth, "page_height_mm", pageHeight, "unit", "mm", "coordinates", "page_top_left",
            "consistency", "live_not_atomic", "powerclip_contents_included", false), "rows", rows);
        // This file can be larger than a tool reply; serialize completely before
        // publishing it, so an error does not destroy a previous catalogue.
        var writer = new JavaScriptSerializer { MaxJsonLength = 100000000 };
        WriteJsonOutput(destination, writer.Serialize(payload), overwrite);
        var info = new System.IO.FileInfo(destination);
        if (!info.Exists || info.Length == 0) throw new System.IO.IOException("Catalogue was not written: " + destination);
        return Obj("document_id", documentId, "document_path", documentPath, "path", destination, "bytes", info.Length,
            "page", pageNumber, "unit", "mm", "coordinates", "page_top_left", "total", total[0], "top_level", rows.Count,
            "page_width_mm", pageWidth, "page_height_mm", pageHeight, "include_text", includeText,
            "consistency", "live_not_atomic", "powerclip_contents_included", false);
    }
}
