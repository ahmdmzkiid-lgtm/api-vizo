import express from 'express';
import multer from 'multer';
import slugify from 'slugify';
import prisma from '../lib/prisma.js';
import { uploadToR2, deleteFromR2, getDownloadUrl, getFileStream } from '../lib/r2.js';
import { authenticateToken, canManageCourse } from '../middleware/auth.js';

const router = express.Router();

// Multer memory storage (holds file in memory buffer before streaming to Cloudflare R2)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
});

// POST /api/materials/upload - Upload file or add external link
router.post(
  '/upload',
  authenticateToken,
  canManageCourse,
  upload.single('file'),
  async (req, res) => {
    try {
      const {
        sessionId,
        courseId,
        title,
        type, // PDF, SLIDE, VIDEO_LINK, DRIVE_LINK, NOTE, OTHER
        externalUrl,
      } = req.body;

      if (!sessionId || !title || !type) {
        return res.status(400).json({ message: 'Session ID, Judul Materi, dan Jenis Materi wajib diisi.' });
      }

      let fileUrl = externalUrl || '';
      let r2Key = null;
      let fileSize = null;

      // If a file was uploaded, send it to Cloudflare R2
      if (req.file) {
        const cleanName = slugify(req.file.originalname, { lower: true, strict: true });
        const timestamp = Date.now();
        r2Key = `materials/course-${courseId}/session-${sessionId}/${timestamp}-${cleanName}`;

        const uploadResult = await uploadToR2(req.file.buffer, r2Key, req.file.mimetype);
        fileUrl = uploadResult.url;
        fileSize = BigInt(req.file.size);
      } else if (!fileUrl) {
        return res.status(400).json({ message: 'Harap sertakan file untuk diunggah atau URL tautan materi.' });
      }

      const material = await prisma.material.create({
        data: {
          sessionId: Number(sessionId),
          title,
          type,
          r2Key,
          fileUrl,
          fileSize,
          uploadedById: req.user.id,
        },
        include: {
          uploadedBy: {
            select: { id: true, name: true },
          },
        },
      });

      return res.status(201).json({
        message: 'Materi berhasil ditambahkan ke Cloudflare R2 & database.',
        material,
      });
    } catch (error) {
      console.error('Material upload error:', error);
      return res.status(500).json({ message: 'Gagal mengunggah materi.' });
    }
  }
);

// GET /api/materials/:id/view - Stream or proxy material file for in-app preview or direct browser viewing
router.get('/:id/view', authenticateToken, async (req, res) => {
  try {
    const materialId = Number(req.params.id);
    const material = await prisma.material.findUnique({
      where: { id: materialId },
    });

    if (!material) {
      return res.status(404).send('Materi tidak ditemukan.');
    }

    const isDownload = req.query.download === 'true' || req.query.download === '1';
    const dispositionType = isDownload ? 'attachment' : 'inline';
    const safeTitle = (material.title || 'document').replace(/[/\\?%*:|"<>]/g, '_');

    if (material.r2Key) {
      try {
        const streamData = await getFileStream(material.r2Key);
        res.setHeader('Content-Type', streamData.ContentType || 'application/pdf');
        res.setHeader('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(safeTitle)}.pdf"`);
        if (streamData.ContentLength) {
          res.setHeader('Content-Length', streamData.ContentLength);
        }
        return streamData.Body.pipe(res);
      } catch (streamErr) {
        console.error('Error streaming material from R2:', streamErr);
      }
    }

    // Fallback: If external URL or stream failed
    if (material.fileUrl) {
      return res.redirect(material.fileUrl);
    }

    return res.status(404).send('File materi tidak ditemukan.');
  } catch (error) {
    console.error('View material error:', error);
    return res.status(500).send('Gagal memuat file materi.');
  }
});

// GET /api/materials/:id/download - Get signed or direct download link
router.get('/:id/download', authenticateToken, async (req, res) => {
  try {
    const materialId = Number(req.params.id);
    const material = await prisma.material.findUnique({
      where: { id: materialId },
    });

    if (!material) {
      return res.status(404).json({ message: 'Materi tidak ditemukan.' });
    }

    if (material.r2Key) {
      const downloadUrl = await getDownloadUrl(material.r2Key);
      return res.json({ url: downloadUrl, isExternal: false });
    }

    return res.json({ url: material.fileUrl, isExternal: true });
  } catch (error) {
    console.error('Download material error:', error);
    return res.status(500).json({ message: 'Gagal menghasilkan tautan unduhan.' });
  }
});

// DELETE /api/materials/:id - Delete material (PJ or Ketua Kelas)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const materialId = Number(req.params.id);

    const material = await prisma.material.findUnique({
      where: { id: materialId },
      include: {
        session: {
          select: { courseId: true },
        },
      },
    });

    if (!material) {
      return res.status(404).json({ message: 'Materi tidak ditemukan.' });
    }

    // Check if user is Ketua Kelas or the PJ for that course
    if (req.user.role !== 'KETUA_KELAS') {
      const isPJ = await prisma.courseCoordinator.findUnique({
        where: {
          courseId_userId: {
            courseId: material.session.courseId,
            userId: req.user.id,
          },
        },
      });

      if (!isPJ && material.uploadedById !== req.user.id) {
        return res.status(403).json({ message: 'Akses ditolak untuk menghapus materi ini.' });
      }
    }

    // Delete from R2 if key exists
    if (material.r2Key) {
      try {
        await deleteFromR2(material.r2Key);
      } catch (r2Err) {
        console.warn('Failed to delete object from R2:', r2Err);
      }
    }

    await prisma.material.delete({
      where: { id: materialId },
    });

    return res.json({ message: 'Materi berhasil dihapus.' });
  } catch (error) {
    console.error('Delete material error:', error);
    return res.status(500).json({ message: 'Gagal menghapus materi.' });
  }
});

export default router;
