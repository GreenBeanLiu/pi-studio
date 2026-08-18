param(
  [Parameter(Mandatory = $true)][string]$EncodedSpec,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'

if (-not ('PiStudio.EvalJob' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace PiStudio {
  public static class EvalJob {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint INFINITE = 0xFFFFFFFF;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public int cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      bool inheritHandles,
      uint creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
      var output = new StringBuilder("\"");
      var slashes = 0;
      foreach (var character in value) {
        if (character == '\\') { slashes++; continue; }
        if (character == '"') {
          output.Append('\\', slashes * 2 + 1).Append('"');
          slashes = 0;
          continue;
        }
        output.Append('\\', slashes).Append(character);
        slashes = 0;
      }
      output.Append('\\', slashes * 2).Append('"');
      return output.ToString();
    }

    public static int Run(string executable, string[] arguments, string workingDirectory) {
      var job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      PROCESS_INFORMATION process = new PROCESS_INFORMATION();
      try {
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        var pointer = Marshal.AllocHGlobal(length);
        try {
          Marshal.StructureToPtr(limits, pointer, false);
          if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)length))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
          Marshal.FreeHGlobal(pointer);
        }

        var command = new StringBuilder(Quote(executable));
        foreach (var argument in arguments) command.Append(' ').Append(Quote(argument));
        var startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(-10);
        startup.hStdOutput = GetStdHandle(-11);
        startup.hStdError = GetStdHandle(-12);
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED,
          IntPtr.Zero, workingDirectory, ref startup, out process))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!AssignProcessToJobObject(job, process.hProcess)) {
          TerminateProcess(process.hProcess, 125);
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (ResumeThread(process.hThread) == 0xFFFFFFFF)
          throw new Win32Exception(Marshal.GetLastWin32Error());
        WaitForSingleObject(process.hProcess, INFINITE);
        uint exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode))
          throw new Win32Exception(Marshal.GetLastWin32Error());
        return unchecked((int)exitCode);
      } finally {
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
        if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        CloseHandle(job);
      }
    }
  }
}
'@
}

try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedSpec))
  $spec = $json | ConvertFrom-Json
  $arguments = @($spec.args | ForEach-Object { [string]$_ })
  $exitCode = [PiStudio.EvalJob]::Run([string]$spec.executable, $arguments, (Get-Location).Path)
  [IO.File]::WriteAllText($ResultPath, (@{ kind = 'exit'; exitCode = $exitCode } | ConvertTo-Json -Compress))
  exit $exitCode
} catch {
  [IO.File]::WriteAllText($ResultPath, (@{ kind = 'infrastructure-error'; message = $_.Exception.Message } | ConvertTo-Json -Compress))
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 125
}
