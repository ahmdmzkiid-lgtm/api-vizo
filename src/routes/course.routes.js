import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticateToken, requireRole, canManageCourse } from '../middleware/auth.js';

const router = express.Router();

// GET /api/courses - List all courses
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { semester, search } = req.query;

    const where = {};
    if (semester && semester !== 'ALL') {
      where.semester = Number(semester);
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { lecturerName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const courses = await prisma.course.findMany({
      where,
      include: {
        coordinators: {
          include: {
            user: {
              select: { id: true, name: true, nim: true },
            },
          },
        },
        _count: {
          select: {
            sessions: true,
            assignments: true,
          },
        },
      },
      orderBy: [{ semester: 'asc' }, { name: 'asc' }],
    });

    return res.json({ courses });
  } catch (error) {
    console.error('Get courses error:', error);
    return res.status(500).json({ message: 'Gagal memuat daftar mata kuliah.' });
  }
});

// GET /api/courses/:id - Course detail with sessions & materials
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const courseId = Number(req.params.id);

    const course = await prisma.course.findUnique({
      where: { id: courseId },
      include: {
        coordinators: {
          include: {
            user: {
              select: { id: true, name: true, nim: true, email: true },
            },
          },
        },
        sessions: {
          include: {
            materials: {
              include: {
                uploadedBy: {
                  select: { id: true, name: true },
                },
              },
              orderBy: { createdAt: 'desc' },
            },
          },
          orderBy: { sessionNumber: 'asc' },
        },
        assignments: {
          orderBy: { deadline: 'asc' },
        },
      },
    });

    if (!course) {
      return res.status(404).json({ message: 'Mata kuliah tidak ditemukan.' });
    }

    return res.json({ course });
  } catch (error) {
    console.error('Get course detail error:', error);
    return res.status(500).json({ message: 'Gagal memuat detail mata kuliah.' });
  }
});

// POST /api/courses - Create course (Ketua Kelas only)
router.post('/', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const {
      code,
      name,
      semester,
      credits,
      lecturerName,
      lecturerContact,
      scheduleDay,
      scheduleTime,
      room,
      description,
      coordinatorUserIds,
    } = req.body;

    if (!code || !name || !semester || !lecturerName) {
      return res.status(400).json({ message: 'Singkatan, Nama Matkul, Semester, dan Nama Dosen wajib diisi.' });
    }

    const existing = await prisma.course.findUnique({ where: { code } });
    if (existing) {
      return res.status(400).json({ message: `Mata kuliah dengan singkatan ${code} sudah ada.` });
    }

    // Auto-create 16 sessions (1 to 16, with 8 as UTS and 16 as UAS)
    const initialSessions = Array.from({ length: 16 }, (_, i) => {
      const num = i + 1;
      let topic = `Pertemuan ${num}`;
      if (num === 8) topic = 'Pertemuan 8 (Ujian Tengah Semester - UTS)';
      if (num === 16) topic = 'Pertemuan 16 (Ujian Akhir Semester - UAS)';
      return {
        sessionNumber: num,
        topicTitle: topic,
      };
    });

    const newCourse = await prisma.course.create({
      data: {
        code,
        name,
        semester: Number(semester),
        credits: Number(credits || 3),
        lecturerName,
        lecturerContact,
        scheduleDay: scheduleDay || 'Senin',
        scheduleTime: scheduleTime || '08:00 - 10:30 WIB',
        room: room || 'Ruang Kuliah',
        description,
        sessions: {
          create: initialSessions,
        },
        coordinators: coordinatorUserIds && coordinatorUserIds.length > 0 ? {
          create: coordinatorUserIds.map((userId) => ({ userId: Number(userId) })),
        } : undefined,
      },
      include: {
        coordinators: {
          include: {
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    return res.status(201).json({
      message: 'Mata kuliah dan 16 pertemuan berhasil dibuat.',
      course: newCourse,
    });
  } catch (error) {
    console.error('Create course error:', error);
    return res.status(500).json({ message: 'Gagal membuat mata kuliah.' });
  }
});

// PUT /api/courses/:courseId - Full edit course (Ketua Kelas or assigned PJ Matkul)
router.put('/:courseId', authenticateToken, canManageCourse, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const {
      code,
      name,
      semester,
      credits,
      lecturerName,
      lecturerContact,
      scheduleDay,
      scheduleTime,
      room,
      description,
    } = req.body;

    const updated = await prisma.course.update({
      where: { id: courseId },
      data: {
        code: code ? code.toUpperCase() : undefined,
        name,
        semester: semester ? Number(semester) : undefined,
        credits: credits ? Number(credits) : undefined,
        lecturerName,
        lecturerContact,
        scheduleDay,
        scheduleTime,
        room,
        description,
      },
    });

    return res.json({ message: 'Data mata kuliah berhasil diperbarui.', course: updated });
  } catch (error) {
    console.error('Update course error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui mata kuliah.' });
  }
});

// DELETE /api/courses/:courseId - Delete Course (Ketua Kelas only)
router.delete('/:courseId', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);

    await prisma.course.delete({
      where: { id: courseId },
    });

    return res.json({ message: 'Mata kuliah berhasil dihapus dari arsip kelas.' });
  } catch (error) {
    console.error('Delete course error:', error);
    return res.status(500).json({ message: 'Gagal menghapus mata kuliah.' });
  }
});

// POST /api/courses/:id/coordinators - Set/Assign Coordinators (Ketua Kelas only)
router.post('/:courseId/coordinators', authenticateToken, requireRole('KETUA_KELAS'), async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const { userIds } = req.body;

    await prisma.courseCoordinator.deleteMany({
      where: { courseId },
    });

    if (userIds && userIds.length > 0) {
      await prisma.courseCoordinator.createMany({
        data: userIds.map((userId) => ({
          courseId,
          userId: Number(userId),
        })),
      });

      await prisma.user.updateMany({
        where: {
          id: { in: userIds.map(Number) },
          role: 'MAHASISWA',
        },
        data: { role: 'PJ_MATKUL' },
      });
    }

    return res.json({ message: 'Koordinator/PJ Matkul berhasil diperbarui.' });
  } catch (error) {
    console.error('Set coordinators error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui koordinator.' });
  }
});

export default router;
