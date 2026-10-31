import express from 'express';
import prisma from '../lib/prisma.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();

/**
 * GET /api/cash
 * Mengambil seluruh data uang kas: ringkasan saldo, daftar periode iuran,
 * status pembayaran mahasiswa, buku transaksi kas (pemasukan/pengeluaran),
 * serta daftar bendahara kelas.
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const [students, periods, transactions] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          nim: true,
          name: true,
          email: true,
          role: true,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.cashPeriod.findMany({
        include: {
          createdBy: {
            select: { id: true, name: true, role: true },
          },
          payments: {
            include: {
              user: {
                select: { id: true, nim: true, name: true },
              },
              recordedBy: {
                select: { id: true, name: true },
              },
            },
            orderBy: { paidAt: 'desc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.cashTransaction.findMany({
        include: {
          createdBy: {
            select: { id: true, name: true, role: true },
          },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    const totalStudents = students.length;
    const totalPeriods = periods.length;

    const totalDuesIncome = periods.reduce((sum, p) => {
      const periodPaid = (p.payments || []).reduce(
        (acc, pay) => acc + (Number(pay.amountPaid) || 0),
        0
      );
      return sum + periodPaid;
    }, 0);

    const totalTargetDues = periods.reduce(
      (sum, p) => sum + (Number(p.amount) || 0) * totalStudents,
      0
    );

    const totalOtherIncome = transactions
      .filter((t) => t.type === 'INCOME')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const totalExpense = transactions
      .filter((t) => t.type === 'EXPENSE')
      .reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

    const totalIncome = totalDuesIncome + totalOtherIncome;
    const balance = totalIncome - totalExpense;

    // Status pembayaran pribadi untuk user yang sedang login
    const myUserId = req.user.id;
    let paidPeriodsCount = 0;
    let totalPaidByMe = 0;
    let totalUnpaidByMe = 0;
    const unpaidPeriods = [];

    for (const period of periods) {
      const myPayment = (period.payments || []).find((pay) => pay.userId === myUserId);
      if (myPayment) {
        paidPeriodsCount += 1;
        totalPaidByMe += Number(myPayment.amountPaid) || 0;
      } else {
        totalUnpaidByMe += Number(period.amount) || 0;
        unpaidPeriods.push({
          id: period.id,
          title: period.title,
          category: period.category,
          amount: period.amount,
          dueDate: period.dueDate,
        });
      }
    }

    const treasurers = students.filter((s) => s.role === 'BENDAHARA');

    return res.json({
      summary: {
        balance,
        totalIncome,
        totalDuesIncome,
        totalTargetDues,
        totalOtherIncome,
        totalExpense,
        totalStudents,
        totalPeriods,
        myStatus: {
          paidPeriodsCount,
          unpaidPeriodsCount: Math.max(0, totalPeriods - paidPeriodsCount),
          totalPaidByMe,
          totalUnpaidByMe,
          unpaidPeriods,
        },
      },
      treasurers,
      students,
      periods,
      transactions,
    });
  } catch (error) {
    console.error('Get cash data error:', error);
    return res.status(500).json({ message: 'Gagal memuat data uang kas kelas.' });
  }
});

/**
 * POST /api/cash/periods
 * Membuat periode tagihan kas baru (Bendahara / Ketua Kelas)
 */
router.post(
  '/periods',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const { title, category, amount, dueDate, notes } = req.body;

      if (!title || !String(title).trim()) {
        return res.status(400).json({ message: 'Nama periode kas wajib diisi.' });
      }

      const parsedAmount = Number(amount);
      if (!parsedAmount || parsedAmount <= 0) {
        return res.status(400).json({ message: 'Nominal tagihan kas harus lebih dari Rp 0.' });
      }

      const period = await prisma.cashPeriod.create({
        data: {
          title: String(title).trim(),
          category: category || 'MINGGUAN',
          amount: parsedAmount,
          dueDate: dueDate ? new Date(dueDate) : null,
          notes: notes ? String(notes).trim() : null,
          createdById: req.user.id,
        },
        include: {
          createdBy: { select: { id: true, name: true, role: true } },
          payments: true,
        },
      });

      return res.status(201).json({
        message: 'Periode tagihan kas berhasil dibuat.',
        period,
      });
    } catch (error) {
      console.error('Create cash period error:', error);
      return res.status(500).json({ message: 'Gagal membuat periode kas baru.' });
    }
  }
);

/**
 * PUT /api/cash/periods/:periodId
 * Memperbarui informasi periode tagihan kas (Bendahara / Ketua Kelas)
 */
router.put(
  '/periods/:periodId',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const periodId = Number(req.params.periodId);
      const { title, category, amount, dueDate, notes, isActive, syncExistingPayments } = req.body;

      const existing = await prisma.cashPeriod.findUnique({
        where: { id: periodId },
      });

      if (!existing) {
        return res.status(404).json({ message: 'Periode kas tidak ditemukan.' });
      }

      const newAmount = amount !== undefined ? Number(amount) : existing.amount;
      if (newAmount <= 0) {
        return res.status(400).json({ message: 'Nominal tagihan kas harus lebih dari Rp 0.' });
      }

      const updated = await prisma.cashPeriod.update({
        where: { id: periodId },
        data: {
          title: title ? String(title).trim() : existing.title,
          category: category || existing.category,
          amount: newAmount,
          dueDate: dueDate !== undefined ? (dueDate ? new Date(dueDate) : null) : existing.dueDate,
          notes: notes !== undefined ? (notes ? String(notes).trim() : null) : existing.notes,
          isActive: isActive !== undefined ? Boolean(isActive) : existing.isActive,
        },
      });

      // Jika nominal periode berubah dan syncExistingPayments aktif (default true), sesuaikan pembayaran yang bernilai nominal lama
      if (newAmount !== existing.amount && syncExistingPayments !== false) {
        await prisma.cashPayment.updateMany({
          where: {
            periodId,
            amountPaid: existing.amount,
          },
          data: {
            amountPaid: newAmount,
          },
        });
      }

      return res.json({
        message: 'Periode kas berhasil diperbarui.',
        period: updated,
      });
    } catch (error) {
      console.error('Update cash period error:', error);
      return res.status(500).json({ message: 'Gagal memperbarui periode kas.' });
    }
  }
);

/**
 * DELETE /api/cash/periods/:periodId
 * Menghapus periode tagihan kas beserta data pembayarannya (Bendahara / Ketua Kelas)
 */
router.delete(
  '/periods/:periodId',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const periodId = Number(req.params.periodId);
      await prisma.cashPeriod.delete({
        where: { id: periodId },
      });

      return res.json({ message: 'Periode kas berhasil dihapus.' });
    } catch (error) {
      console.error('Delete cash period error:', error);
      return res.status(500).json({ message: 'Gagal menghapus periode kas.' });
    }
  }
);

/**
 * POST /api/cash/periods/:periodId/payments/toggle
 * Mencatat atau membatalkan status lunas mahasiswa pada suatu periode kas (Bendahara / Ketua Kelas)
 */
router.post(
  '/periods/:periodId/payments/toggle',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const periodId = Number(req.params.periodId);
      const { userId, isPaid, paymentMethod, note, amountPaid } = req.body;

      if (!userId) {
        return res.status(400).json({ message: 'ID mahasiswa wajib disertakan.' });
      }

      const period = await prisma.cashPeriod.findUnique({
        where: { id: periodId },
      });

      if (!period) {
        return res.status(404).json({ message: 'Periode kas tidak ditemukan.' });
      }

      const existingPayment = await prisma.cashPayment.findUnique({
        where: {
          periodId_userId: {
            periodId,
            userId: Number(userId),
          },
        },
      });

      const targetPaidState = isPaid !== undefined ? Boolean(isPaid) : !existingPayment;

      if (!targetPaidState) {
        if (existingPayment) {
          await prisma.cashPayment.delete({
            where: { id: existingPayment.id },
          });
        }
        return res.json({
          message: 'Status pembayaran diubah menjadi Belum Lunas.',
          isPaid: false,
          payment: null,
        });
      }

      const finalAmount =
        amountPaid !== undefined && Number(amountPaid) > 0
          ? Number(amountPaid)
          : period.amount;

      const payment = await prisma.cashPayment.upsert({
        where: {
          periodId_userId: {
            periodId,
            userId: Number(userId),
          },
        },
        update: {
          amountPaid: finalAmount,
          paymentMethod: paymentMethod || existingPayment?.paymentMethod || 'TUNAI',
          note: note !== undefined ? (note ? String(note).trim() : null) : existingPayment?.note,
          recordedById: req.user.id,
        },
        create: {
          periodId,
          userId: Number(userId),
          amountPaid: finalAmount,
          paymentMethod: paymentMethod || 'TUNAI',
          note: note ? String(note).trim() : null,
          recordedById: req.user.id,
          paidAt: new Date(),
        },
        include: {
          user: { select: { id: true, nim: true, name: true } },
          recordedBy: { select: { id: true, name: true } },
        },
      });

      return res.json({
        message: `Pembayaran kas ${payment.user.name} berhasil dicatat Lunas.`,
        isPaid: true,
        payment,
      });
    } catch (error) {
      console.error('Toggle cash payment error:', error);
      return res.status(500).json({ message: 'Gagal memperbarui status pembayaran kas.' });
    }
  }
);

/**
 * POST /api/cash/periods/:periodId/payments/bulk
 * Checklist / unchecklist massal pembayaran mahasiswa pada suatu periode (Bendahara / Ketua Kelas)
 */
router.post(
  '/periods/:periodId/payments/bulk',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const periodId = Number(req.params.periodId);
      const { userIds, isPaid = true, paymentMethod = 'TUNAI', note = null } = req.body;

      if (!Array.isArray(userIds) || userIds.length === 0) {
        return res.status(400).json({ message: 'Pilih minimal satu mahasiswa.' });
      }

      const period = await prisma.cashPeriod.findUnique({
        where: { id: periodId },
      });

      if (!period) {
        return res.status(404).json({ message: 'Periode kas tidak ditemukan.' });
      }

      const numericUserIds = userIds.map((id) => Number(id));

      if (!isPaid) {
        await prisma.cashPayment.deleteMany({
          where: {
            periodId,
            userId: { in: numericUserIds },
          },
        });
        return res.json({
          message: `${numericUserIds.length} mahasiswa ditandai Belum Lunas.`,
        });
      }

      // Cari siapa yang sudah punya record pembayaran di periode ini
      const existingPayments = await prisma.cashPayment.findMany({
        where: {
          periodId,
          userId: { in: numericUserIds },
        },
        select: { userId: true },
      });

      const existingSet = new Set(existingPayments.map((p) => p.userId));
      const toCreate = numericUserIds
        .filter((uid) => !existingSet.has(uid))
        .map((uid) => ({
          periodId,
          userId: uid,
          amountPaid: period.amount,
          paymentMethod: paymentMethod || 'TUNAI',
          note: note ? String(note).trim() : null,
          recordedById: req.user.id,
          paidAt: new Date(),
        }));

      if (toCreate.length > 0) {
        await prisma.cashPayment.createMany({
          data: toCreate,
        });
      }

      return res.json({
        message: `${numericUserIds.length} mahasiswa berhasil ditandai Lunas.`,
      });
    } catch (error) {
      console.error('Bulk cash payment error:', error);
      return res.status(500).json({ message: 'Gagal memproses pembayaran massal.' });
    }
  }
);

/**
 * POST /api/cash/transactions
 * Mencatat transaksi Buku Kas (Pengeluaran atau Pemasukan Lain) (Bendahara / Ketua Kelas)
 */
router.post(
  '/transactions',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const { type, category, title, amount, date, paymentMethod, notes } = req.body;

      if (!title || !String(title).trim()) {
        return res.status(400).json({ message: 'Judul atau keterangan transaksi wajib diisi.' });
      }

      const parsedAmount = Number(amount);
      if (!parsedAmount || parsedAmount <= 0) {
        return res.status(400).json({ message: 'Nominal transaksi harus lebih dari Rp 0.' });
      }

      const normalizedType = type === 'INCOME' ? 'INCOME' : 'EXPENSE';

      const transaction = await prisma.cashTransaction.create({
        data: {
          type: normalizedType,
          category: category || (normalizedType === 'EXPENSE' ? 'KEPERLUAN_KELAS' : 'PEMASUKAN_LAIN'),
          title: String(title).trim(),
          amount: parsedAmount,
          date: date ? new Date(date) : new Date(),
          paymentMethod: paymentMethod || 'TUNAI',
          notes: notes ? String(notes).trim() : null,
          createdById: req.user.id,
        },
        include: {
          createdBy: { select: { id: true, name: true, role: true } },
        },
      });

      return res.status(201).json({
        message:
          normalizedType === 'EXPENSE'
            ? 'Pengeluaran kas berhasil dicatat.'
            : 'Pemasukan kas berhasil dicatat.',
        transaction,
      });
    } catch (error) {
      console.error('Create cash transaction error:', error);
      return res.status(500).json({ message: 'Gagal mencatat transaksi buku kas.' });
    }
  }
);

/**
 * PUT /api/cash/transactions/:id
 * Mengubah data transaksi Buku Kas (Bendahara / Ketua Kelas)
 */
router.put(
  '/transactions/:id',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const txId = Number(req.params.id);
      const { type, category, title, amount, date, paymentMethod, notes } = req.body;

      const existing = await prisma.cashTransaction.findUnique({
        where: { id: txId },
      });

      if (!existing) {
        return res.status(404).json({ message: 'Transaksi kas tidak ditemukan.' });
      }

      const parsedAmount = amount !== undefined ? Number(amount) : existing.amount;
      if (parsedAmount <= 0) {
        return res.status(400).json({ message: 'Nominal transaksi harus lebih dari Rp 0.' });
      }

      const updated = await prisma.cashTransaction.update({
        where: { id: txId },
        data: {
          type: type ? (type === 'INCOME' ? 'INCOME' : 'EXPENSE') : existing.type,
          category: category || existing.category,
          title: title ? String(title).trim() : existing.title,
          amount: parsedAmount,
          date: date ? new Date(date) : existing.date,
          paymentMethod: paymentMethod || existing.paymentMethod,
          notes: notes !== undefined ? (notes ? String(notes).trim() : null) : existing.notes,
        },
        include: {
          createdBy: { select: { id: true, name: true, role: true } },
        },
      });

      return res.json({
        message: 'Transaksi buku kas berhasil diperbarui.',
        transaction: updated,
      });
    } catch (error) {
      console.error('Update cash transaction error:', error);
      return res.status(500).json({ message: 'Gagal memperbarui transaksi buku kas.' });
    }
  }
);

/**
 * DELETE /api/cash/transactions/:id
 * Menghapus transaksi Buku Kas (Bendahara / Ketua Kelas)
 */
router.delete(
  '/transactions/:id',
  authenticateToken,
  requireRole('KETUA_KELAS', 'BENDAHARA'),
  async (req, res) => {
    try {
      const txId = Number(req.params.id);
      await prisma.cashTransaction.delete({
        where: { id: txId },
      });

      return res.json({ message: 'Transaksi buku kas berhasil dihapus.' });
    } catch (error) {
      console.error('Delete cash transaction error:', error);
      return res.status(500).json({ message: 'Gagal menghapus transaksi buku kas.' });
    }
  }
);

export default router;
