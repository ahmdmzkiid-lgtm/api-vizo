import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticateToken } from '../middleware/auth.js';
import { streamExplanation, checkRateLimit } from '../lib/ai.js';

const router = express.Router();

/**
 * GET /api/quiz/courses/:courseId/summary
 * Mengambil ringkasan bank soal: daftar sesi, materi PDF yang ada,
 * cakupan halaman yang sudah dikerjakan (coverage), dan total kontribusi.
 */
router.get('/courses/:courseId/summary', authenticateToken, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    if (!courseId) {
      return res.status(400).json({ message: 'ID mata kuliah tidak valid.' });
    }

    // Ambil sesi mata kuliah beserta file materi dan kontribusi
    const sessions = await prisma.session.findMany({
      where: { courseId },
      include: {
        materials: {
          where: { type: 'PDF' },
          select: { id: true, title: true, fileUrl: true },
        },
        quizContributions: {
          include: {
            user: {
              select: { id: true, name: true, nim: true },
            },
            _count: {
              select: { questions: true },
            },
          },
          orderBy: { startPage: 'asc' },
        },
        _count: {
          select: { questions: true },
        },
      },
      orderBy: { sessionNumber: 'asc' },
    });

    // Hitung total pertanyaan di seluruh mata kuliah dan breakdown per tipe
    const totalQuestions = await prisma.question.count({
      where: { courseId },
    });

    const multipleChoiceCount = await prisma.question.count({
      where: { courseId, type: 'MULTIPLE_CHOICE' },
    });
    const shortAnswerCount = await prisma.question.count({
      where: { courseId, type: 'SHORT_ANSWER' },
    });
    const essayCount = await prisma.question.count({
      where: { courseId, type: 'ESSAY' },
    });

    // Kontributor teraktif (Top Contributors)
    const topContributors = await prisma.quizContribution.groupBy({
      by: ['userId'],
      where: { courseId },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    });

    const userIds = topContributors.map((c) => c.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, nim: true },
    });

    const leaderboard = topContributors.map((item) => {
      const u = users.find((user) => user.id === item.userId);
      return {
        userId: item.userId,
        name: u?.name || 'Mahasiswa',
        nim: u?.nim || '-',
        contributionsCount: item._count.id,
      };
    });

    return res.json({
      summary: {
        totalQuestions,
        multipleChoiceCount,
        shortAnswerCount,
        essayCount,
        leaderboard,
      },
      sessions: sessions.map((s) => ({
        id: s.id,
        sessionNumber: s.sessionNumber,
        topicTitle: s.topicTitle,
        materials: s.materials,
        questionsCount: s._count.questions,
        contributions: s.quizContributions.map((c) => ({
          id: c.id,
          startPage: c.startPage,
          endPage: c.endPage,
          notes: c.notes,
          isVerified: c.isVerified,
          createdAt: c.createdAt,
          contributor: c.user,
          questionsCount: c._count.questions,
        })),
      })),
    });
  } catch (error) {
    console.error('Get quiz summary error:', error);
    return res.status(500).json({ message: 'Gagal memuat ringkasan bank soal.' });
  }
});

/**
 * GET /api/quiz/courses/:courseId/questions
 * Mengambil daftar soal untuk latihan. Bisa difilter per sesi atau acak.
 */
router.get('/courses/:courseId/questions', authenticateToken, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const { sessionId, type, limit, contributionId } = req.query;

    const where = { courseId };
    if (sessionId && sessionId !== 'ALL') {
      where.sessionId = Number(sessionId);
    }
    if (contributionId) {
      where.contributionId = Number(contributionId);
    }
    if (type && type !== 'ALL') {
      where.type = type;
    }

    const questions = await prisma.question.findMany({
      where,
      include: {
        session: {
          select: { id: true, sessionNumber: true, topicTitle: true },
        },
        createdBy: {
          select: { id: true, name: true, nim: true },
        },
        contribution: {
          select: { id: true, startPage: true, endPage: true, isVerified: true },
        },
      },
      orderBy: [{ sessionId: 'asc' }, { pageReference: 'asc' }, { id: 'asc' }],
      take: limit ? Number(limit) : 100,
    });

    return res.json({ questions });
  } catch (error) {
    console.error('Get questions error:', error);
    return res.status(500).json({ message: 'Gagal memuat soal latihan.' });
  }
});

/**
 * POST /api/quiz/courses/:courseId/contributions
 * Mahasiswa membuat kontribusi soal baru dari rentang halaman PDF dosen.
 */
router.post('/courses/:courseId/contributions', authenticateToken, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const { sessionId, materialId, startPage, endPage, notes, questions } = req.body;

    if (!sessionId || !startPage || !endPage) {
      return res.status(400).json({
        message: 'Pertemuan (sesi) dan rentang halaman wajib diisi.',
      });
    }

    const startP = Number(startPage);
    const endP = Number(endPage);

    if (startP <= 0 || endP < startP) {
      return res.status(400).json({
        message: 'Rentang halaman tidak valid (Halaman akhir harus >= halaman awal).',
      });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({
        message: 'Minimal tambahkan 1 soal dalam paket kontribusi ini.',
      });
    }

    // Validasi setiap pertanyaan
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.questionText || !q.questionText.trim()) {
        return res.status(400).json({
          message: `Pertanyaan nomor ${i + 1} tidak boleh kosong.`,
        });
      }

      if (q.type === 'MULTIPLE_CHOICE') {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          return res.status(400).json({
            message: `Soal pilihan ganda nomor ${i + 1} harus memiliki minimal opsi A dan B.`,
          });
        }
        if (!q.correctAnswer) {
          return res.status(400).json({
            message: `Kunci jawaban untuk soal pilihan ganda nomor ${i + 1} wajib dipilih.`,
          });
        }
      } else if (q.type === 'SHORT_ANSWER') {
        if (!q.correctAnswer || !q.correctAnswer.trim()) {
          return res.status(400).json({
            message: `Kunci jawaban untuk isian singkat nomor ${i + 1} wajib diisi.`,
          });
        }
      }
    }

    // Simpan paket kontribusi dan semua pertanyaan secara transaksional
    const result = await prisma.$transaction(async (tx) => {
      const contribution = await tx.quizContribution.create({
        data: {
          courseId,
          sessionId: Number(sessionId),
          materialId: materialId ? Number(materialId) : null,
          userId: req.user.id,
          startPage: startP,
          endPage: endP,
          notes: notes?.trim() || null,
        },
      });

      const questionData = questions.map((q) => ({
        contributionId: contribution.id,
        sessionId: Number(sessionId),
        courseId,
        createdById: req.user.id,
        type: q.type || 'MULTIPLE_CHOICE',
        questionText: q.questionText.trim(),
        pageReference: q.pageReference ? Number(q.pageReference) : startP,
        options: q.type === 'MULTIPLE_CHOICE' ? q.options : null,
        correctAnswer: q.correctAnswer ? String(q.correctAnswer).trim() : null,
        explanation: q.explanation?.trim() || null,
        essayRubric: q.essayRubric?.trim() || null,
      }));

      await tx.question.createMany({
        data: questionData,
      });

      return contribution;
    });

    return res.status(201).json({
      message: 'Paket kontribusi soal berhasil disimpan. Terima kasih atas kontribusimu!',
      contributionId: result.id,
    });
  } catch (error) {
    console.error('Create quiz contribution error:', error);
    return res.status(500).json({ message: 'Gagal menyimpan kontribusi soal.' });
  }
});

/**
 * POST /api/quiz/submit-attempt
 * Submit jawaban latihan kuis untuk auto-grading instan.
 */
router.post('/submit-attempt', authenticateToken, async (req, res) => {
  try {
    const { courseId, sessionId, answers } = req.body;

    if (!courseId || !Array.isArray(answers) || answers.length === 0) {
      return res.status(400).json({ message: 'Data pengerjaan latihan tidak lengkap.' });
    }

    const questionIds = answers.map((a) => Number(a.questionId));
    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds } },
      include: {
        session: { select: { sessionNumber: true, topicTitle: true } },
        createdBy: { select: { name: true, nim: true } },
      },
    });

    let autoGradableCount = 0;
    let correctCount = 0;

    const evaluatedAnswers = answers.map((ans) => {
      const q = questions.find((item) => item.id === Number(ans.questionId));
      if (!q) {
        return {
          questionId: ans.questionId,
          userAnswer: ans.userAnswer,
          isCorrect: false,
        };
      }

      let isCorrect = null;

      if (q.type === 'MULTIPLE_CHOICE') {
        autoGradableCount++;
        const userA = String(ans.userAnswer || '').trim().toUpperCase();
        const correctA = String(q.correctAnswer || '').trim().toUpperCase();
        isCorrect = userA === correctA;
        if (isCorrect) correctCount++;
      } else if (q.type === 'SHORT_ANSWER') {
        autoGradableCount++;
        const userA = String(ans.userAnswer || '').trim().toLowerCase();
        const correctA = String(q.correctAnswer || '').trim().toLowerCase();
        // Cek kecocokan teks toleran
        isCorrect = userA === correctA || correctA.includes(userA) && userA.length > 2;
        if (isCorrect) correctCount++;
      }

      return {
        questionId: q.id,
        contributionId: q.contributionId,
        type: q.type,
        questionText: q.questionText,
        pageReference: q.pageReference,
        userAnswer: ans.userAnswer,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,
        essayRubric: q.essayRubric,
        aiExplanation: q.aiExplanation,
        options: q.options,
        isCorrect,
        session: q.session,
        contributor: q.createdBy,
      };
    });

    const scorePercentage = autoGradableCount > 0 ? (correctCount / autoGradableCount) * 100 : 100;

    // Simpan riwayat attempt
    const attempt = await prisma.quizAttempt.create({
      data: {
        courseId: Number(courseId),
        sessionId: sessionId ? Number(sessionId) : null,
        userId: req.user.id,
        totalScore: Math.round(scorePercentage * 10) / 10,
        totalItems: answers.length,
        answers: {
          create: answers.map((a) => {
            const evaluated = evaluatedAnswers.find((ev) => ev.questionId === Number(a.questionId));
            return {
              questionId: Number(a.questionId),
              userAnswer: String(a.userAnswer || ''),
              isCorrect: evaluated ? evaluated.isCorrect : null,
            };
          }),
        },
      },
    });

    return res.json({
      attemptId: attempt.id,
      score: Math.round(scorePercentage * 10) / 10,
      correctCount,
      autoGradableCount,
      totalItems: answers.length,
      evaluatedAnswers,
    });
  } catch (error) {
    console.error('Submit quiz attempt error:', error);
    return res.status(500).json({ message: 'Gagal mengevaluasi latihan kuis.' });
  }
});

/**
 * PATCH /api/quiz/contributions/:id/verify
 * Verifikasi soal oleh PJ Matkul atau Ketua Kelas.
 */
router.patch('/contributions/:id/verify', authenticateToken, async (req, res) => {
  try {
    const contributionId = Number(req.params.id);
    const contribution = await prisma.quizContribution.findUnique({
      where: { id: contributionId },
      include: {
        course: {
          include: { coordinators: true },
        },
      },
    });

    if (!contribution) {
      return res.status(404).json({ message: 'Kontribusi tidak ditemukan.' });
    }

    const isKetua = req.user.role === 'KETUA_KELAS';
    const isPJ = contribution.course.coordinators.some((c) => c.userId === req.user.id);

    if (!isKetua && !isPJ) {
      return res.status(403).json({
        message: 'Hanya PJ Matkul atau Ketua Kelas yang dapat memverifikasi soal.',
      });
    }

    const updated = await prisma.quizContribution.update({
      where: { id: contributionId },
      data: { isVerified: !contribution.isVerified },
    });

    return res.json({
      message: `Status verifikasi berhasil diubah: ${updated.isVerified ? 'Terverifikasi' : 'Belum Diverifikasi'}`,
      isVerified: updated.isVerified,
    });
  } catch (error) {
    console.error('Verify contribution error:', error);
    return res.status(500).json({ message: 'Gagal mengubah status verifikasi.' });
  }
});

/**
 * DELETE /api/quiz/contributions/:id
 * Menghapus paket kontribusi (Hanya oleh pembuatnya, PJ Matkul, atau Ketua Kelas).
 */
router.delete('/contributions/:id', authenticateToken, async (req, res) => {
  try {
    const contributionId = Number(req.params.id);
    const contribution = await prisma.quizContribution.findUnique({
      where: { id: contributionId },
      include: {
        course: {
          include: { coordinators: true },
        },
      },
    });

    if (!contribution) {
      return res.status(404).json({ message: 'Kontribusi tidak ditemukan.' });
    }

    const isOwner = contribution.userId === req.user.id;
    const isKetua = req.user.role === 'KETUA_KELAS';
    const isPJ = contribution.course.coordinators.some((c) => c.userId === req.user.id);

    if (!isOwner && !isKetua && !isPJ) {
      return res.status(403).json({
        message: 'Akses ditolak. Anda tidak memiliki izin menghapus kontribusi ini.',
      });
    }

    await prisma.quizContribution.delete({
      where: { id: contributionId },
    });

    return res.json({ message: 'Paket kontribusi dan soal terkait berhasil dihapus.' });
  } catch (error) {
    console.error('Delete contribution error:', error);
    return res.status(500).json({ message: 'Gagal menghapus kontribusi.' });
  }
});

/**
 * GET /api/quiz/courses/:courseId/attempts/my
 * Riwayat pengerjaan latihan mahasiswa yang sedang login beserta seluruh butir soal & pembahasan.
 */
router.get('/courses/:courseId/attempts/my', authenticateToken, async (req, res) => {
  try {
    const courseId = Number(req.params.courseId);
    const attempts = await prisma.quizAttempt.findMany({
      where: {
        courseId,
        userId: req.user.id,
      },
      include: {
        answers: {
          include: {
            question: {
              include: {
                session: { select: { id: true, sessionNumber: true, topicTitle: true } },
                createdBy: { select: { id: true, name: true, nim: true } },
              },
            },
          },
        },
      },
      orderBy: { completedAt: 'desc' },
      take: 25,
    });

    const formattedAttempts = attempts.map((att) => {
      let correctCount = 0;
      let autoCount = 0;

      const evaluatedAnswers = att.answers.map((ans) => {
        const q = ans.question;
        if (q.type === 'MULTIPLE_CHOICE' || q.type === 'SHORT_ANSWER') {
          autoCount++;
          if (ans.isCorrect) correctCount++;
        }
        return {
          questionId: q.id,
          contributionId: q.contributionId,
          type: q.type,
          questionText: q.questionText,
          pageReference: q.pageReference,
          options: q.options,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation,
          essayRubric: q.essayRubric,
          aiExplanation: q.aiExplanation,
          userAnswer: ans.userAnswer,
          isCorrect: ans.isCorrect,
          session: q.session,
          contributor: q.createdBy,
        };
      });

      return {
        id: att.id,
        courseId: att.courseId,
        sessionId: att.sessionId,
        totalScore: att.totalScore,
        totalItems: att.totalItems,
        completedAt: att.completedAt,
        correctCount,
        autoCount,
        evaluatedAnswers,
      };
    });

    return res.json({ attempts: formattedAttempts });
  } catch (error) {
    console.error('Get my attempts error:', error);
    return res.status(500).json({ message: 'Gagal memuat riwayat latihan.' });
  }
});

/**
 * GET /api/quiz/attempts/:id
 * Detail riwayat pengerjaan kuis tertentu beserta pembahasannya.
 */
router.get('/attempts/:id', authenticateToken, async (req, res) => {
  try {
    const attemptId = Number(req.params.id);
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      include: {
        answers: {
          include: {
            question: {
              include: {
                session: { select: { id: true, sessionNumber: true, topicTitle: true } },
                createdBy: { select: { id: true, name: true, nim: true } },
              },
            },
          },
        },
      },
    });

    if (!attempt) {
      return res.status(404).json({ message: 'Riwayat latihan tidak ditemukan.' });
    }

    if (attempt.userId !== req.user.id && req.user.role !== 'KETUA_KELAS') {
      return res.status(403).json({ message: 'Akses ditolak.' });
    }

    let correctCount = 0;
    let autoCount = 0;
    const evaluatedAnswers = attempt.answers.map((ans) => {
      const q = ans.question;
      if (q.type === 'MULTIPLE_CHOICE' || q.type === 'SHORT_ANSWER') {
        autoCount++;
        if (ans.isCorrect) correctCount++;
      }
      return {
        questionId: q.id,
        contributionId: q.contributionId,
        type: q.type,
        questionText: q.questionText,
        pageReference: q.pageReference,
        options: q.options,
        correctAnswer: q.correctAnswer,
        explanation: q.explanation,
        essayRubric: q.essayRubric,
        aiExplanation: q.aiExplanation,
        userAnswer: ans.userAnswer,
        isCorrect: ans.isCorrect,
        session: q.session,
        contributor: q.createdBy,
      };
    });

    return res.json({
      attempt: {
        id: attempt.id,
        courseId: attempt.courseId,
        sessionId: attempt.sessionId,
        totalScore: attempt.totalScore,
        totalItems: attempt.totalItems,
        completedAt: attempt.completedAt,
        correctCount,
        autoCount,
        evaluatedAnswers,
      },
    });
  } catch (error) {
    console.error('Get attempt detail error:', error);
    return res.status(500).json({ message: 'Gagal memuat detail riwayat latihan.' });
  }
});

/**
 * POST /api/quiz/questions/:questionId/explain
 * Generate pembahasan AI secara streaming (SSE).
 * Jika sudah ada cache, langsung return tanpa panggil AI.
 */
router.post('/questions/:questionId/explain', authenticateToken, async (req, res) => {
  try {
    const questionId = Number(req.params.questionId);
    const { userAnswer, isCorrect, regenerate } = req.body;

    // Rate limit check
    if (!checkRateLimit(req.user.id)) {
      return res.status(429).json({
        message: 'Terlalu banyak permintaan. Coba lagi dalam 1 menit.',
      });
    }

    // Fetch question dengan relasi
    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: {
        session: { select: { id: true, sessionNumber: true, topicTitle: true } },
        contribution: { select: { id: true, startPage: true, endPage: true } },
      },
    });

    if (!question) {
      return res.status(404).json({ message: 'Soal tidak ditemukan.' });
    }

    // Jika sudah ada cache AI explanation dan bukan regenerate, return langsung (bukan SSE)
    if (question.aiExplanation && !regenerate) {
      return res.json({
        cached: true,
        explanation: question.aiExplanation,
        explainedAt: question.aiExplainedAt,
      });
    }

    // Setup SSE streaming
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const questionData = {
      type: question.type,
      questionText: question.questionText,
      options: question.options,
      correctAnswer: question.correctAnswer,
      userAnswer,
      isCorrect,
      pageReference: question.pageReference,
      explanation: question.explanation,
      essayRubric: question.essayRubric,
      sessionInfo: question.session,
    };

    let fullText = '';

    try {
      for await (const chunk of streamExplanation(questionData)) {
        fullText += chunk;
        res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
      }

      if (fullText.trim().length > 0) {
        await prisma.question.update({
          where: { id: questionId },
          data: {
            aiExplanation: fullText,
            aiExplainedAt: new Date(),
          },
        });
      }

      res.write(`data: ${JSON.stringify({ done: true, full: fullText })}\n\n`);
      res.end();
    } catch (streamError) {
      console.error('AI stream error:', streamError);
      res.write(
        `data: ${JSON.stringify({
          error: true,
          message: 'Gagal memuat pembahasan AI. Coba lagi nanti.',
        })}\n\n`
      );
      res.end();
    }
  } catch (error) {
    console.error('AI explain error:', error);
    if (!res.headersSent) {
      return res.status(500).json({ message: 'Gagal memuat pembahasan AI.' });
    }
    res.end();
  }
});

export default router;
