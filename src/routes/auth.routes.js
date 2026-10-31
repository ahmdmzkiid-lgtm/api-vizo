import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { nim, name, email, password, role } = req.body;

    if (!nim || !name || !email || !password) {
      return res.status(400).json({ message: 'NIM, Nama, Email, dan Password wajib diisi.' });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [{ nim }, { email }],
      },
    });

    if (existingUser) {
      return res.status(400).json({ message: 'NIM atau Email sudah terdaftar.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // If first user, automatically make them KETUA_KELAS
    const userCount = await prisma.user.count();
    const assignedRole = userCount === 0 ? 'KETUA_KELAS' : (role || 'MAHASISWA');

    const newUser = await prisma.user.create({
      data: {
        nim,
        name,
        email,
        passwordHash,
        role: assignedRole,
      },
      select: {
        id: true,
        nim: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    const token = jwt.sign(
      { id: newUser.id, nim: newUser.nim, name: newUser.name, role: newUser.role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    return res.status(201).json({
      message: 'Registrasi berhasil.',
      token,
      user: newUser,
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ message: 'Terjadi kesalahan server saat registrasi.' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body; // identifier can be NIM or Email

    if (!identifier || !password) {
      return res.status(400).json({ message: 'NIM/Email dan Password wajib diisi.' });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [{ nim: identifier }, { email: identifier }],
      },
      include: {
        coordinatedCourses: {
          select: {
            courseId: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(401).json({ message: 'Akun dengan NIM/Email tersebut tidak ditemukan.' });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'Password salah. Silakan coba lagi.' });
    }

    // Cek apakah pengguna masih menggunakan password default (password123)
    const isDefaultPassword = await bcrypt.compare('password123', user.passwordHash);

    const token = jwt.sign(
      { id: user.id, nim: user.nim, name: user.name, role: user.role },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    const coordinatedCourseIds = user.coordinatedCourses.map((c) => c.courseId);

    return res.json({
      message: 'Login berhasil.',
      token,
      user: {
        id: user.id,
        nim: user.nim,
        name: user.name,
        email: user.email,
        role: user.role,
        coordinatedCourseIds,
        isDefaultPassword,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ message: 'Terjadi kesalahan server saat login.' });
  }
});

// Get Current User Profile
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        nim: true,
        name: true,
        email: true,
        role: true,
        passwordHash: true,
        coordinatedCourses: {
          include: {
            course: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
    }

    const isDefaultPassword = await bcrypt.compare('password123', user.passwordHash);
    const { passwordHash, ...safeUser } = user;

    return res.json({
      user: {
        ...safeUser,
        isDefaultPassword,
      },
    });
  } catch (error) {
    console.error('Get profile error:', error);
    return res.status(500).json({ message: 'Gagal mengambil data profil.' });
  }
});

// PUT /api/auth/change-password - Ganti kata sandi
router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || String(newPassword).trim().length < 6) {
      return res.status(400).json({ message: 'Kata sandi baru minimal harus 6 karakter.' });
    }

    if (newPassword === 'password123') {
      return res.status(400).json({ message: 'Kata sandi baru tidak boleh sama dengan password default (password123).' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
    });

    if (!user) {
      return res.status(404).json({ message: 'Pengguna tidak ditemukan.' });
    }

    // Cek apakah saat ini masih password default
    const isDefault = await bcrypt.compare('password123', user.passwordHash);

    // Jika bukan password default, wajib verifikasi kata sandi saat ini
    if (!isDefault) {
      if (!currentPassword) {
        return res.status(400).json({ message: 'Kata sandi saat ini wajib diisi.' });
      }
      const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isMatch) {
        return res.status(400).json({ message: 'Kata sandi saat ini salah.' });
      }
    }

    const newPasswordHash = await bcrypt.hash(String(newPassword).trim(), 10);
    await prisma.user.update({
      where: { id: req.user.id },
      data: { passwordHash: newPasswordHash },
    });

    return res.json({
      message: 'Kata sandi berhasil diperbarui.',
      isDefaultPassword: false,
    });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui kata sandi.' });
  }
});

// Get All Users (for assigning PJ Matkul & Bendahara)
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        nim: true,
        name: true,
        email: true,
        role: true,
        coordinatedCourses: {
          select: {
            course: {
              select: { id: true, code: true, name: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    return res.json({ users });
  } catch (error) {
    console.error('Get users error:', error);
    return res.status(500).json({ message: 'Gagal memuat daftar pengguna.' });
  }
});

// Update User Role (Ketua Kelas only)
router.put('/users/:id/role', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { role } = req.body;

    if (!['KETUA_KELAS', 'BENDAHARA', 'PJ_MATKUL', 'MAHASISWA'].includes(role)) {
      return res.status(400).json({ message: 'Peran tidak valid.' });
    }

    let targetRole = role;
    // Jika dikembalikan ke MAHASISWA tapi user tersebut masih menjadi PJ Matkul, pertahankan role PJ_MATKUL
    if (role === 'MAHASISWA') {
      const coordCount = await prisma.courseCoordinator.count({
        where: { userId },
      });
      if (coordCount > 0) {
        targetRole = 'PJ_MATKUL';
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role: targetRole },
      select: { id: true, nim: true, name: true, email: true, role: true },
    });

    return res.json({ message: 'Peran pengguna berhasil diperbarui.', user: updated });
  } catch (error) {
    console.error('Update role error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui peran.' });
  }
});

// Create New Class Member (Ketua Kelas only)
router.post('/users', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const { nim, name, email, role, password } = req.body;

    if (!nim || !String(nim).trim() || !name || !String(name).trim()) {
      return res.status(400).json({ message: 'NIM/NPM dan Nama Lengkap wajib diisi.' });
    }

    const cleanNim = String(nim).trim();
    const cleanName = String(name).trim();
    const cleanEmail =
      email && String(email).trim()
        ? String(email).trim().toLowerCase()
        : `${cleanNim}@student.gunadarma.ac.id`;

    const existing = await prisma.user.findFirst({
      where: {
        OR: [{ nim: cleanNim }, { email: cleanEmail }],
      },
    });

    if (existing) {
      return res.status(400).json({
        message: 'Mahasiswa dengan NIM/NPM atau Email tersebut sudah terdaftar.',
      });
    }

    const rawPassword = password && String(password).trim().length >= 6 ? String(password).trim() : 'password123';
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    const validRole = ['KETUA_KELAS', 'BENDAHARA', 'PJ_MATKUL', 'MAHASISWA'].includes(role)
      ? role
      : 'MAHASISWA';

    const created = await prisma.user.create({
      data: {
        nim: cleanNim,
        name: cleanName,
        email: cleanEmail,
        passwordHash,
        role: validRole,
      },
      select: {
        id: true,
        nim: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });

    return res.status(201).json({
      message: `Anggota kelas ${created.name} berhasil ditambahkan (Password: ${rawPassword}).`,
      user: created,
    });
  } catch (error) {
    console.error('Admin create user error:', error);
    return res.status(500).json({ message: 'Gagal menambahkan anggota kelas baru.' });
  }
});

// Edit Class Member Profile & Role (Ketua Kelas only)
router.put('/users/:id', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { nim, name, email, role } = req.body;

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(404).json({ message: 'Anggota kelas tidak ditemukan.' });
    }

    const cleanNim = nim ? String(nim).trim() : existing.nim;
    const cleanName = name ? String(name).trim() : existing.name;
    const cleanEmail = email ? String(email).trim().toLowerCase() : existing.email;

    if (cleanNim !== existing.nim || cleanEmail !== existing.email) {
      const duplicate = await prisma.user.findFirst({
        where: {
          id: { not: userId },
          OR: [{ nim: cleanNim }, { email: cleanEmail }],
        },
      });
      if (duplicate) {
        return res.status(400).json({
          message: 'NIM/NPM atau Email sudah digunakan oleh anggota kelas lain.',
        });
      }
    }

    let targetRole = existing.role;
    if (role && ['KETUA_KELAS', 'BENDAHARA', 'PJ_MATKUL', 'MAHASISWA'].includes(role)) {
      targetRole = role;
      if (role === 'MAHASISWA') {
        const coordCount = await prisma.courseCoordinator.count({ where: { userId } });
        if (coordCount > 0) targetRole = 'PJ_MATKUL';
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        nim: cleanNim,
        name: cleanName,
        email: cleanEmail,
        role: targetRole,
      },
      select: {
        id: true,
        nim: true,
        name: true,
        email: true,
        role: true,
      },
    });

    return res.json({
      message: `Data anggota ${updated.name} berhasil diperbarui.`,
      user: updated,
    });
  } catch (error) {
    console.error('Admin update user error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui data anggota kelas.' });
  }
});

// Reset Member Password (Ketua Kelas only)
router.post(
  '/users/:id/reset-password',
  authenticateToken,
  requireRole('KETUA_KELAS'),
  async (req, res) => {
    try {
      const userId = Number(req.params.id);
      const { newPassword } = req.body;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return res.status(404).json({ message: 'Anggota kelas tidak ditemukan.' });
      }

      const targetPassword =
        newPassword && String(newPassword).trim().length >= 6
          ? String(newPassword).trim()
          : 'password123';

      const passwordHash = await bcrypt.hash(targetPassword, 10);

      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      });

      return res.json({
        message: `Kata sandi ${user.name} (${user.nim}) berhasil di-reset menjadi: ${targetPassword}`,
        resetPasswordTo: targetPassword,
      });
    } catch (error) {
      console.error('Admin reset password error:', error);
      return res.status(500).json({ message: 'Gagal me-reset kata sandi anggota.' });
    }
  }
);

// Delete Class Member (Ketua Kelas only)
router.delete('/users/:id', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (userId === req.user.id) {
      return res.status(400).json({
        message: 'Anda tidak dapat menghapus akun Anda sendiri yang sedang digunakan.',
      });
    }

    const existing = await prisma.user.findUnique({ where: { id: userId } });
    if (!existing) {
      return res.status(404).json({ message: 'Anggota kelas tidak ditemukan.' });
    }

    await prisma.user.delete({ where: { id: userId } });

    return res.json({
      message: `Akun anggota ${existing.name} (${existing.nim}) berhasil dihapus dari kelas.`,
    });
  } catch (error) {
    console.error('Admin delete user error:', error);
    return res.status(500).json({ message: 'Gagal menghapus anggota kelas.' });
  }
});

export default router;
