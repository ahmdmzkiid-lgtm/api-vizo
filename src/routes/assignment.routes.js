import express from 'express';
import multer from 'multer';
import slugify from 'slugify';
import prisma from '../lib/prisma.js';
import { uploadToR2 } from '../lib/r2.js';
import { authenticateToken, canManageCourse } from '../middleware/auth.js';

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// GET /api/assignments - Global Deadline Tracker
router.get('/', authenticateToken, async (req, res) => {
  try {
    const assignments = await prisma.assignment.findMany({
      include: {
        course: {
          select: {
            id: true,
            code: true,
            name: true,
            lecturerName: true,
          },
        },
        createdBy: {
          select: { id: true, name: true },
        },
        submissions: {
          where: { userId: req.user.id },
          select: { id: true, submittedAt: true, fileUrl: true },
        },
      },
      orderBy: { deadline: 'asc' },
    });

    return res.json({ assignments });
  } catch (error) {
    console.error('Get assignments error:', error);
    return res.status(500).json({ message: 'Gagal memuat daftar tugas.' });
  }
});

// POST /api/assignments - Create Assignment (PJ or Ketua Kelas)
router.post(
  '/',
  authenticateToken,
  canManageCourse,
  upload.single('file'),
  async (req, res) => {
    try {
      const { courseId, title, description, deadline, isCollective } = req.body;

      if (!courseId || !title || !description || !deadline) {
        return res.status(400).json({ message: 'Mata Kuliah, Judul, Deskripsi, dan Deadline wajib diisi.' });
      }

      let r2AttachmentKey = null;
      let attachmentUrl = null;

      if (req.file) {
        const cleanName = slugify(req.file.originalname, { lower: true, strict: true });
        r2AttachmentKey = `assignments/course-${courseId}/task-${Date.now()}-${cleanName}`;
        const uploadResult = await uploadToR2(req.file.buffer, r2AttachmentKey, req.file.mimetype);
        attachmentUrl = uploadResult.url;
      }

      const assignment = await prisma.assignment.create({
        data: {
          courseId: Number(courseId),
          title,
          description,
          deadline: new Date(deadline),
          r2AttachmentKey,
          attachmentUrl,
          isCollective: isCollective === 'true' || isCollective === true,
          createdById: req.user.id,
        },
      });

      return res.status(201).json({
        message: 'Tugas perkuliahan berhasil dibuat.',
        assignment,
      });
    } catch (error) {
      console.error('Create assignment error:', error);
      return res.status(500).json({ message: 'Gagal membuat tugas.' });
    }
  }
);

// POST /api/assignments/:id/submit - Submit assignment by student
router.post(
  '/:id/submit',
  authenticateToken,
  upload.single('file'),
  async (req, res) => {
    try {
      const assignmentId = Number(req.params.id);
      const { note } = req.body;

      if (!req.file) {
        return res.status(400).json({ message: 'Wajib melampirkan file pengumpulan tugas.' });
      }

      const cleanName = slugify(req.file.originalname, { lower: true, strict: true });
      const r2SubmissionKey = `submissions/task-${assignmentId}/user-${req.user.id}-${Date.now()}-${cleanName}`;
      const uploadResult = await uploadToR2(req.file.buffer, r2SubmissionKey, req.file.mimetype);

      const submission = await prisma.submission.upsert({
        where: {
          assignmentId_userId: {
            assignmentId,
            userId: req.user.id,
          },
        },
        update: {
          r2SubmissionKey,
          fileUrl: uploadResult.url,
          note,
          submittedAt: new Date(),
        },
        create: {
          assignmentId,
          userId: req.user.id,
          r2SubmissionKey,
          fileUrl: uploadResult.url,
          note,
        },
      });

      return res.status(201).json({
        message: 'Tugas Anda berhasil diunggah ke Cloudflare R2.',
        submission,
      });
    } catch (error) {
      console.error('Submit assignment error:', error);
      return res.status(500).json({ message: 'Gagal mengumpulkan tugas.' });
    }
  }
);

// GET /api/assignments/:id/submissions - Submissions list (PJ or Ketua Kelas)
router.get('/:id/submissions', authenticateToken, async (req, res) => {
  try {
    const assignmentId = Number(req.params.id);
    const assignment = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: {
        submissions: {
          include: {
            user: {
              select: { id: true, nim: true, name: true, email: true },
            },
          },
          orderBy: { submittedAt: 'asc' },
        },
      },
    });

    if (!assignment) {
      return res.status(404).json({ message: 'Tugas tidak ditemukan.' });
    }

    return res.json({ submissions: assignment.submissions });
  } catch (error) {
    console.error('Get submissions error:', error);
    return res.status(500).json({ message: 'Gagal memuat daftar pengumpulan.' });
  }
});

export default router;
