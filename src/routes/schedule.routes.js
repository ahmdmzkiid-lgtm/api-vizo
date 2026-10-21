import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticateToken, canManageCourse, requireRole } from '../middleware/auth.js';

const router = express.Router();

// GET /api/schedules - Get all weekly schedules, active reschedules, practicum schedules, and general class agendas
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [courses, practicums, agendas] = await Promise.all([
      prisma.course.findMany({
        include: {
          coordinators: {
            include: {
              user: { select: { id: true, name: true, nim: true } },
            },
          },
          reschedules: {
            where: { isActive: true },
            orderBy: { newDate: 'asc' },
          },
          practicums: {
            orderBy: [{ day: 'asc' }, { startTime: 'asc' }],
          },
        },
        orderBy: [{ scheduleDay: 'asc' }, { scheduleTime: 'asc' }],
      }),
      prisma.practicumSchedule.findMany({
        include: {
          course: {
            select: { id: true, code: true, name: true, semester: true },
          },
        },
        orderBy: [{ day: 'asc' }, { date: 'asc' }, { startTime: 'asc' }],
      }),
      prisma.classAgenda.findMany({
        include: {
          createdBy: {
            select: { id: true, name: true, nim: true, role: true },
          },
        },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      }),
    ]);

    return res.json({ courses, practicums, agendas });
  } catch (error) {
    console.error('Get schedules error:', error);
    return res.status(500).json({ message: 'Gagal memuat jadwal perkuliahan, praktikum & agenda kelas.' });
  }
});

// PUT /api/schedules/course/:courseId - Update regular schedule & room (PJ or Ketua Kelas)
router.put('/course/:courseId', authenticateToken, canManageCourse, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const { scheduleDay, scheduleTime, room } = req.body;

    const updated = await prisma.course.update({
      where: { id: courseId },
      data: {
        scheduleDay,
        scheduleTime,
        room,
      },
    });

    return res.json({
      message: 'Jadwal reguler dan ruangan perkuliahan berhasil diperbarui.',
      course: updated,
    });
  } catch (error) {
    console.error('Update schedule error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui jadwal reguler.' });
  }
});

// POST /api/schedules/reschedule - Create class reschedule (PJ or Ketua Kelas)
router.post('/reschedule', authenticateToken, canManageCourse, async (req, res) => {
  try {
    const { courseId, newDate, newStartTime, newEndTime, newRoom, reason, originalDate } = req.body;

    if (!courseId || !newDate || !newStartTime) {
      return res.status(400).json({ message: 'Mata kuliah, tanggal baru, dan jam mulai wajib diisi.' });
    }

    const reschedule = await prisma.classReschedule.create({
      data: {
        courseId: Number(courseId),
        originalDate: originalDate ? new Date(originalDate) : undefined,
        newDate: new Date(newDate),
        newStartTime,
        newEndTime,
        newRoom: newRoom || 'Sesuai info PJ',
        reason: reason || 'Permintaan dosen pengampu',
        isActive: true,
      },
    });

    return res.status(201).json({
      message: 'Jadwal reschedule perkuliahan berhasil dicatat.',
      reschedule,
    });
  } catch (error) {
    console.error('Create reschedule error:', error);
    return res.status(500).json({ message: 'Gagal mencatat reschedule perkuliahan.' });
  }
});

// DELETE /api/schedules/reschedule/:id - Cancel/remove reschedule (PJ or Ketua Kelas)
router.delete('/reschedule/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const reschedule = await prisma.classReschedule.findUnique({
      where: { id },
      include: {
        course: {
          include: { coordinators: true },
        },
      },
    });

    if (!reschedule) {
      return res.status(404).json({ message: 'Data reschedule tidak ditemukan.' });
    }

    // Check permission: Ketua Kelas or PJ of this course
    if (req.user.role !== 'KETUA_KELAS') {
      const isPJ = reschedule.course.coordinators.some((c) => c.userId === req.user.id);
      if (!isPJ) {
        return res.status(403).json({ message: 'Akses ditolak.' });
      }
    }

    await prisma.classReschedule.delete({
      where: { id },
    });

    return res.json({ message: 'Jadwal reschedule berhasil dibatalkan.' });
  } catch (error) {
    console.error('Delete reschedule error:', error);
    return res.status(500).json({ message: 'Gagal membatalkan reschedule.' });
  }
});

// =========================================================================
// PRACTICUM SCHEDULES (JADWAL PRAKTIKUM / LAB)
// =========================================================================

// POST /api/schedules/practicum - Tambah jadwal praktikum (Ketua Kelas atau PJ Matkul)
router.post('/practicum', authenticateToken, async (req, res) => {
  try {
    const {
      courseId,
      title,
      day,
      date,
      startTime,
      endTime,
      room,
      assistant,
      group,
      notes,
      isRecurring = true,
    } = req.body;

    if (!title || !startTime || !room) {
      return res.status(400).json({ message: 'Judul praktikum, jam mulai, dan ruangan lab wajib diisi.' });
    }

    if (isRecurring && !day) {
      return res.status(400).json({ message: 'Hari praktikum wajib dipilih untuk jadwal rutin mingguan.' });
    }

    if (!isRecurring && !date) {
      return res.status(400).json({ message: 'Tanggal praktikum wajib diisi jika bukan jadwal rutin mingguan.' });
    }

    // Permission check: Ketua Kelas or PJ of course
    if (req.user.role !== 'KETUA_KELAS') {
      if (!courseId) {
        return res.status(403).json({
          message: 'Hanya Ketua Kelas atau PJ Matkul yang dapat menambahkan jadwal praktikum.',
        });
      }
      const coordinator = await prisma.courseCoordinator.findUnique({
        where: {
          courseId_userId: {
            courseId: Number(courseId),
            userId: req.user.id,
          },
        },
      });
      if (!coordinator) {
        return res.status(403).json({
          message: 'Hanya Ketua Kelas atau PJ Matkul terkait yang berhak menambah jadwal praktikum ini.',
        });
      }
    }

    const practicum = await prisma.practicumSchedule.create({
      data: {
        courseId: courseId ? Number(courseId) : null,
        title: String(title).trim(),
        day: isRecurring ? (Array.isArray(day) ? day.join(', ') : String(day).trim()) : null,
        date: !isRecurring && date ? new Date(date) : null,
        startTime: String(startTime).trim(),
        endTime: endTime ? String(endTime).trim() : null,
        room: String(room).trim(),
        assistant: assistant ? String(assistant).trim() : null,
        group: group ? String(group).trim() : null,
        notes: notes ? String(notes).trim() : null,
        isRecurring: Boolean(isRecurring),
      },
      include: {
        course: {
          select: { id: true, code: true, name: true, semester: true },
        },
      },
    });

    return res.status(201).json({
      message: 'Jadwal praktikum berhasil ditambahkan.',
      practicum,
    });
  } catch (error) {
    console.error('Create practicum error:', error);
    return res.status(500).json({ message: 'Gagal menambahkan jadwal praktikum.' });
  }
});

// PUT /api/schedules/practicum/:id - Ubah jadwal praktikum (Ketua Kelas atau PJ Matkul)
router.put('/practicum/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      courseId,
      title,
      day,
      date,
      startTime,
      endTime,
      room,
      assistant,
      group,
      notes,
      isRecurring = true,
    } = req.body;

    const existing = await prisma.practicumSchedule.findUnique({
      where: { id },
      include: {
        course: {
          include: { coordinators: true },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Jadwal praktikum tidak ditemukan.' });
    }

    // Permission check
    if (req.user.role !== 'KETUA_KELAS') {
      const isExistingPJ = existing.course?.coordinators.some((c) => c.userId === req.user.id);
      if (!isExistingPJ) {
        return res.status(403).json({ message: 'Akses ditolak. Anda bukan PJ dari mata kuliah ini.' });
      }
    }

    const updated = await prisma.practicumSchedule.update({
      where: { id },
      data: {
        courseId: courseId ? Number(courseId) : null,
        title: title ? String(title).trim() : existing.title,
        day: isRecurring ? (Array.isArray(day) ? day.join(', ') : String(day || existing.day).trim()) : null,
        date: !isRecurring && date ? new Date(date) : (isRecurring ? null : existing.date),
        startTime: startTime ? String(startTime).trim() : existing.startTime,
        endTime: endTime !== undefined ? (endTime ? String(endTime).trim() : null) : existing.endTime,
        room: room ? String(room).trim() : existing.room,
        assistant: assistant !== undefined ? (assistant ? String(assistant).trim() : null) : existing.assistant,
        group: group !== undefined ? (group ? String(group).trim() : null) : existing.group,
        notes: notes !== undefined ? (notes ? String(notes).trim() : null) : existing.notes,
        isRecurring: Boolean(isRecurring),
      },
      include: {
        course: {
          select: { id: true, code: true, name: true, semester: true },
        },
      },
    });

    return res.json({
      message: 'Jadwal praktikum berhasil diperbarui.',
      practicum: updated,
    });
  } catch (error) {
    console.error('Update practicum error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui jadwal praktikum.' });
  }
});

// DELETE /api/schedules/practicum/:id - Hapus jadwal praktikum (Ketua Kelas atau PJ Matkul)
router.delete('/practicum/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const existing = await prisma.practicumSchedule.findUnique({
      where: { id },
      include: {
        course: {
          include: { coordinators: true },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Jadwal praktikum tidak ditemukan.' });
    }

    // Permission check
    if (req.user.role !== 'KETUA_KELAS') {
      const isPJ = existing.course?.coordinators.some((c) => c.userId === req.user.id);
      if (!isPJ) {
        return res.status(403).json({ message: 'Akses ditolak.' });
      }
    }

    await prisma.practicumSchedule.delete({
      where: { id },
    });

    return res.json({ message: 'Jadwal praktikum berhasil dihapus.' });
  } catch (error) {
    console.error('Delete practicum error:', error);
    return res.status(500).json({ message: 'Gagal menghapus jadwal praktikum.' });
  }
});

// =========================================================================
// CLASS AGENDAS (AGENDA UMUM / DILUAR MATKUL & PRAKTIKUM)
// =========================================================================

// POST /api/schedules/agenda - Tambah agenda kelas umum
router.post('/agenda', authenticateToken, async (req, res) => {
  try {
    const { title, category = 'UMUM', date, startTime, endTime, location, description } = req.body;

    if (!title || !date || !startTime) {
      return res.status(400).json({ message: 'Judul, tanggal, dan jam mulai agenda wajib diisi.' });
    }

    const agenda = await prisma.classAgenda.create({
      data: {
        title: String(title).trim(),
        category: category ? String(category).trim().toUpperCase() : 'UMUM',
        date: new Date(date),
        startTime: String(startTime).trim(),
        endTime: endTime ? String(endTime).trim() : null,
        location: location ? String(location).trim() : 'Ruang Kelas / Online',
        description: description ? String(description).trim() : null,
        createdById: req.user.id,
      },
      include: {
        createdBy: {
          select: { id: true, name: true, nim: true, role: true },
        },
      },
    });

    return res.status(201).json({
      message: 'Agenda kegiatan kelas berhasil ditambahkan.',
      agenda,
    });
  } catch (error) {
    console.error('Create agenda error:', error);
    return res.status(500).json({ message: 'Gagal menambahkan agenda kegiatan.' });
  }
});

// PUT /api/schedules/agenda/:id - Ubah agenda kelas umum (Ketua Kelas atau Pembuat Agenda)
router.put('/agenda/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { title, category, date, startTime, endTime, location, description } = req.body;

    const existing = await prisma.classAgenda.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Agenda kegiatan tidak ditemukan.' });
    }

    // Permission check: Ketua Kelas or Creator
    if (req.user.role !== 'KETUA_KELAS' && existing.createdById !== req.user.id) {
      return res.status(403).json({ message: 'Akses ditolak. Anda tidak berhak mengubah agenda ini.' });
    }

    const updated = await prisma.classAgenda.update({
      where: { id },
      data: {
        title: title ? String(title).trim() : existing.title,
        category: category ? String(category).trim().toUpperCase() : existing.category,
        date: date ? new Date(date) : existing.date,
        startTime: startTime ? String(startTime).trim() : existing.startTime,
        endTime: endTime !== undefined ? (endTime ? String(endTime).trim() : null) : existing.endTime,
        location: location !== undefined ? (location ? String(location).trim() : 'Ruang Kelas / Online') : existing.location,
        description: description !== undefined ? (description ? String(description).trim() : null) : existing.description,
      },
      include: {
        createdBy: {
          select: { id: true, name: true, nim: true, role: true },
        },
      },
    });

    return res.json({
      message: 'Agenda kegiatan berhasil diperbarui.',
      agenda: updated,
    });
  } catch (error) {
    console.error('Update agenda error:', error);
    return res.status(500).json({ message: 'Gagal memperbarui agenda kegiatan.' });
  }
});

// DELETE /api/schedules/agenda/:id - Hapus agenda kelas (Ketua Kelas atau Pembuat Agenda)
router.delete('/agenda/:id', authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const existing = await prisma.classAgenda.findUnique({
      where: { id },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Agenda kegiatan tidak ditemukan.' });
    }

    // Permission check: Ketua Kelas or Creator
    if (req.user.role !== 'KETUA_KELAS' && existing.createdById !== req.user.id) {
      return res.status(403).json({ message: 'Akses ditolak. Anda tidak berhak menghapus agenda ini.' });
    }

    await prisma.classAgenda.delete({
      where: { id },
    });

    return res.json({ message: 'Agenda kegiatan berhasil dihapus.' });
  } catch (error) {
    console.error('Delete agenda error:', error);
    return res.status(500).json({ message: 'Gagal menghapus agenda kegiatan.' });
  }
});

export default router;
