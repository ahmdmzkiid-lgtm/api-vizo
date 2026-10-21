import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

// GET /api/announcements
router.get('/', authenticateToken, async (req, res) => {
  try {
    const announcements = await prisma.announcement.findMany({
      orderBy: [{ isUrgent: 'desc' }, { createdAt: 'desc' }],
    });
    return res.json({ announcements });
  } catch (error) {
    console.error('Get announcements error:', error);
    return res.status(500).json({ message: 'Gagal memuat pengumuman.' });
  }
});

// POST /api/announcements (Ketua Kelas only)
router.post('/', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const { title, content, isUrgent } = req.body;

    if (!title || !content) {
      return res.status(400).json({ message: 'Judul dan Konten pengumuman wajib diisi.' });
    }

    const announcement = await prisma.announcement.create({
      data: {
        title,
        content,
        isUrgent: Boolean(isUrgent),
      },
    });

    return res.status(201).json({
      message: 'Pengumuman kelas berhasil dipublikasikan.',
      announcement,
    });
  } catch (error) {
    console.error('Create announcement error:', error);
    return res.status(500).json({ message: 'Gagal membuat pengumuman.' });
  }
});

// DELETE /api/announcements/:id (Ketua Kelas only)
router.delete('/:id', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.announcement.delete({ where: { id } });
    return res.json({ message: 'Pengumuman berhasil dihapus.' });
  } catch (error) {
    console.error('Delete announcement error:', error);
    return res.status(500).json({ message: 'Gagal menghapus pengumuman.' });
  }
});

export default router;
