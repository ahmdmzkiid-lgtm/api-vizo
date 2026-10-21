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

// Get All Users (for assigning PJ Matkul)
router.get('/users', authenticateToken, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        nim: true,
        name: true,
        email: true,
        role: true,
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

    if (!['KETUA_KELAS', 'PJ_MATKUL', 'MAHASISWA'].includes(role)) {
      return res.status(400).json({ message: 'Peran tidak valid.' });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { role },
      select: { id: true, name: true, role: true },
    });

    return res.json({ message: 'Peran pengguna berhasil diperbarui.', user: updated });
  } catch (error) {
    console.error('Update role error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui peran.' });
  }
});

export default router;
