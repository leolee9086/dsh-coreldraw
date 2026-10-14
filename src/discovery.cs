// CorelDRAW registers open documents even when its Application ProgID is absent
// from the ROT. Query the document's explicit dispatch interface: its default
// IDispatch belongs to the OLE container and does not expose Application.
namespace CorelDiscovery {
    using System;
    using System.Collections.Generic;
    using System.IO;
    using System.Runtime.InteropServices;
    using System.Runtime.InteropServices.ComTypes;
    using System.Text;

    [ComImport, Guid("B0580024-9AA4-44FD-9547-4F91EB757AC4"), InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
    interface IRunningDocument {
        [DispId(1610743808)] object Application { [return: MarshalAs(UnmanagedType.IDispatch)] get; }
    }

    public sealed class Instance {
        public int Pid;
        public long Hwnd;
        public string Started, Title, Version, Source;
        public object Application;
        public Dictionary<string, object> Describe() {
            return new Dictionary<string, object> {
                {"pid", Pid}, {"instance_id", Pid + ":" + Started}, {"window_handle", Hwnd.ToString()},
                {"title", Title}, {"version", Version}, {"connectable", Application != null}, {"source", Source}
            };
        }
    }

    public sealed class Scan {
        public readonly Dictionary<int, Instance> Instances = new Dictionary<int, Instance>();
        public readonly List<object> Diagnostics = new List<object>();
        public bool Incomplete;

        public object[] Rows() {
            var ids = new List<int>(Instances.Keys); ids.Sort();
            var rows = new List<object>(); foreach (int id in ids) rows.Add(Instances[id].Describe()); return rows.ToArray();
        }
        public void Error(string source, Exception error) {
            // An absent active object is normal for Corel. Other discovery
            // failures leave existence uncertain, so never use them to launch.
            if (!(source.StartsWith("active-object:") && error.HResult == unchecked((int)0x800401E3))) Incomplete = true;
            Diagnostics.Add(new { source = source, message = error.Message, hresult = "0x" + error.HResult.ToString("X8") });
        }
    }

    public static class Discovery {
        delegate bool EnumWindow(IntPtr hwnd, IntPtr parameter);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int length);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
        [DllImport("ole32.dll")] static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable table);
        [DllImport("ole32.dll")] static extern int CreateBindCtx(int reserved, out IBindCtx context);

        // Limited-information handles work when .NET Framework's module-based
        // GetProcessesByName silently omits a process it cannot fully inspect.
        public static string Identity(int pid) {
            IntPtr handle = OpenProcess(0x1000, false, pid);
            if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            try {
                var path = new StringBuilder(32768); int length = path.Capacity;
                if (!QueryFullProcessImageName(handle, 0, path, ref length)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                if (!String.Equals(Path.GetFileName(path.ToString()), "CorelDRW.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("PID is not CorelDRAW");
                long created, exited, kernel, user;
                if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                return created.ToString();
            } finally { CloseHandle(handle); }
        }
        static string Title(IntPtr hwnd) { var text = new StringBuilder(4096); GetWindowText(hwnd, text, text.Capacity); return text.ToString(); }
        public static Instance FromApp(object value, string source) {
            dynamic app = value;
            // Corel exposes a signed 32-bit HWND, including in the x64 type library.
            IntPtr hwnd = new IntPtr(unchecked((long)(uint)(int)app.AppWindow.Handle));
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) throw new InvalidOperationException("CorelDRAW application window is no longer valid");
            return new Instance { Pid = checked((int)pid), Hwnd = hwnd.ToInt64(), Started = Identity((int)pid),
                Title = Title(hwnd), Version = Convert.ToString(app.Version), Application = value, Source = source };
        }
        static void Add(Scan scan, object app, string source) {
            Instance item = FromApp(app, source); scan.Instances[item.Pid] = item;
        }
        public static Scan Discover(string progId, object connected) {
            var scan = new Scan();
            EnumWindow callback = (hwnd, unused) => {
                uint pid; GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0 || scan.Instances.ContainsKey((int)pid)) return true;
                string title = Title(hwnd);
                if (!title.StartsWith("CorelDRAW", StringComparison.OrdinalIgnoreCase)) return true;
                try { scan.Instances[(int)pid] = new Instance { Pid=(int)pid, Hwnd=hwnd.ToInt64(), Started=Identity((int)pid), Title=title, Source="window" }; }
                catch (Exception error) { scan.Error("window:" + pid, error); }
                return true;
            };
            if (!EnumWindows(callback, IntPtr.Zero)) scan.Error("windows", new InvalidOperationException("Window enumeration failed"));
            if (connected != null) { try { Add(scan, connected, "connected"); } catch(Exception error) { scan.Error("connected", error); } }
            try { Add(scan, Marshal.GetActiveObject(progId), "active-object"); }
            catch (Exception error) { scan.Error("active-object:" + progId, error); }

            IRunningObjectTable rot = null; IBindCtx context = null; IEnumMoniker iterator = null;
            try {
                Marshal.ThrowExceptionForHR(GetRunningObjectTable(0, out rot));
                Marshal.ThrowExceptionForHR(CreateBindCtx(0, out context));
                rot.EnumRunning(out iterator); var entries = new IMoniker[1];
                while (iterator.Next(1, entries, IntPtr.Zero) == 0) {
                    IMoniker entry = entries[0];
                    try {
                        string display; entry.GetDisplayName(context, null, out display);
                        // Only bind entries identifying Corel or CDR documents.
                        bool document = display.EndsWith(".cdr", StringComparison.OrdinalIgnoreCase);
                        if (!document && display.IndexOf("CorelDRAW", StringComparison.OrdinalIgnoreCase) < 0 && display.IndexOf("CBA900", StringComparison.OrdinalIgnoreCase) < 0) continue;
                        object value; Marshal.ThrowExceptionForHR(rot.GetObject(entry, out value));
                        object app = document ? ((IRunningDocument)value).Application : value;
                        Add(scan, app, document ? "document-rot" : "application-rot");
                    } catch (Exception error) { scan.Error("rot-entry", error); }
                    finally { Marshal.ReleaseComObject(entry); }
                }
            } catch (Exception error) { scan.Error("rot", error); }
            finally {
                if (iterator != null) Marshal.ReleaseComObject(iterator);
                if (context != null) Marshal.ReleaseComObject(context);
                if (rot != null) Marshal.ReleaseComObject(rot);
            }
            return scan;
        }
    }
}
