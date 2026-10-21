/**
 * Classic-BPF seccomp filter that bubblewrap installs (`--seccomp <fd>`) on the TeX process tree,
 * after the sandbox is built. The container's seccomp profile must allow user namespaces and mounts so
 * bwrap can build the sandbox; this filter takes them away again from everything running inside:
 * no new namespaces (clone with CLONE_NEW* flags, unshare, setns), no mounts, no ptrace, bpf,
 * perf, keyrings, io_uring or kernel modules. clone3 returns ENOSYS so glibc falls back to clone,
 * whose flags we can inspect. Unknown architectures and the x32 ABI are killed.
 *
 * This replaces `bwrap --disable-userns`, which needs a writable /proc/sys (Docker mounts it read-only).
 */

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;

const RET_ALLOW = 0x7fff0000;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;

const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0_LOW = 16;

const AUDIT_ARCH_X86_64 = 0xc000003e;
const AUDIT_ARCH_AARCH64 = 0xc00000b7;
const X32_SYSCALL_BIT = 0x40000000;

/** CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET */
export const CLONE_NAMESPACE_FLAGS = 0x7e020000;

type Table = { clone: number; clone3: number; denied: number[] };

// Syscall numbers: unshare, setns, mount, umount2, pivot_root, open_tree, move_mount, fsopen, fsconfig,
// fsmount, fspick, mount_setattr, ptrace, bpf, perf_event_open, userfaultfd, keyctl, add_key,
// request_key, io_uring_setup, init_module, finit_module, delete_module, kexec_load.
const X86_64: Table = {
  clone: 56,
  clone3: 435,
  denied: [272, 308, 165, 166, 155, 428, 429, 430, 431, 432, 433, 442, 101, 321, 298, 323, 250, 248, 249, 425, 175, 313, 176, 246],
};
const AARCH64: Table = {
  clone: 220,
  clone3: 435,
  denied: [97, 268, 40, 39, 41, 428, 429, 430, 431, 432, 433, 442, 117, 280, 241, 282, 219, 217, 218, 425, 105, 273, 106, 104],
};

type Insn = { code: number; jt?: string | number; jf?: string | number; k: number; label?: string };

function assemble(program: Insn[]): Buffer {
  const labels = new Map<string, number>();
  program.forEach((insn, index) => insn.label && labels.set(insn.label, index));
  const out = Buffer.alloc(program.length * 8);
  program.forEach((insn, index) => {
    const offset = (target: string | number | undefined) => {
      if (target === undefined) return 0;
      if (typeof target === "number") return target;
      const at = labels.get(target);
      if (at === undefined) throw new Error(`unknown label ${target}`);
      const delta = at - index - 1;
      if (delta < 0 || delta > 255) throw new Error(`jump out of range to ${target}`);
      return delta;
    };
    out.writeUInt16LE(insn.code, index * 8);
    out.writeUInt8(offset(insn.jt), index * 8 + 2);
    out.writeUInt8(offset(insn.jf), index * 8 + 3);
    out.writeUInt32LE(insn.k >>> 0, index * 8 + 4);
  });
  return out;
}

function archBlock(prefix: string, table: Table, x32: boolean): Insn[] {
  const block: Insn[] = [{ label: prefix, code: BPF_LD_W_ABS, k: OFFSET_NR }];
  if (x32) block.push({ code: BPF_JGE_K, k: X32_SYSCALL_BIT, jt: "deny", jf: 0 });
  block.push({ code: BPF_JEQ_K, k: table.clone, jt: "clone", jf: 0 });
  block.push({ code: BPF_JEQ_K, k: table.clone3, jt: "enosys", jf: 0 });
  for (const nr of table.denied) block.push({ code: BPF_JEQ_K, k: nr, jt: "deny", jf: 0 });
  block.push({ code: BPF_RET_K, k: RET_ALLOW });
  return block;
}

/** The filter as `struct sock_filter[]` bytes (little-endian; both supported arches are LE). */
export function sandboxSeccompFilter(): Buffer {
  return assemble([
    { code: BPF_LD_W_ABS, k: OFFSET_ARCH },
    { code: BPF_JEQ_K, k: AUDIT_ARCH_X86_64, jt: "x86_64", jf: 0 },
    { code: BPF_JEQ_K, k: AUDIT_ARCH_AARCH64, jt: "aarch64", jf: 0 },
    { code: BPF_RET_K, k: RET_KILL_PROCESS },
    ...archBlock("x86_64", X86_64, true),
    ...archBlock("aarch64", AARCH64, false),
    { label: "clone", code: BPF_LD_W_ABS, k: OFFSET_ARG0_LOW },
    { code: BPF_JSET_K, k: CLONE_NAMESPACE_FLAGS, jt: "deny", jf: 0 },
    { code: BPF_RET_K, k: RET_ALLOW },
    { label: "deny", code: BPF_RET_K, k: RET_ERRNO | EPERM },
    { label: "enosys", code: BPF_RET_K, k: RET_ERRNO | ENOSYS },
  ]);
}
