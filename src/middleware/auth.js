import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma.js';

export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) {
    return res.status(401).json({ message: 'Token otentikasi tidak ditemukan. Silakan login.' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, user) => {
    if (err) {
      return res.status(403).json({ message: 'Sesi telah kedaluwarsa atau token tidak valid.' });
    }
    req.user = user;
    next();
  });
}

/**
 * Middleware to restrict route to specific roles
 * Example: requireRole('KETUA_KELAS')
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Tidak terotentikasi.' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ 
        message: `Akses ditolak. Fitur ini hanya untuk peran: ${allowedRoles.join(', ')}` 
      });
    }

    next();
  };
}

/**
 * Middleware: Allows Ketua Kelas OR the assigned PJ Matkul for the course
 */
export async function canManageCourse(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Tidak terotentikasi.' });
    }

    // Ketua Kelas has global manage rights
    if (req.user.role === 'KETUA_KELAS') {
      return next();
    }

    const courseId = Number(req.params.courseId || req.body.courseId);
    if (!courseId) {
      return res.status(400).json({ message: 'ID mata kuliah tidak valid.' });
    }

    // Check if user is assigned as coordinator for this course
    const coordinator = await prisma.courseCoordinator.findUnique({
      where: {
        courseId_userId: {
          courseId,
          userId: req.user.id,
        },
      },
    });

    if (coordinator) {
      return next();
    }

    return res.status(403).json({ 
      message: 'Akses ditolak: Anda bukan Koordinator/PJ untuk mata kuliah ini.' 
    });
  } catch (error) {
    console.error('Authorization error:', error);
    return res.status(500).json({ message: 'Terjadi kesalahan saat memeriksa izin akses.' });
  }
}
