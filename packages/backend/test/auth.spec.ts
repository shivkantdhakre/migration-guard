import { describe, it, expect, beforeEach } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { DatabaseService } from '../src/database/database.service';
import { JwtService } from '@nestjs/jwt';
import { appConfig } from '../src/config/configuration';

describe('AuthModule', () => {
  let db: DatabaseService;
  let jwt: JwtService;
  let authService: AuthService;

  beforeEach(async () => {
    db = new DatabaseService();
    await db.onModuleInit();
    db.resetMemoryStore();

    jwt = new JwtService({
      secret: appConfig.jwtSecret,
      signOptions: { expiresIn: '1h' },
    });
    authService = new AuthService(db, jwt);
  });

  const rand = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  it('should register a new user, create default workspace, and return JWT token', async () => {
    const email = `alice_${rand}@example.com`;
    const res = await authService.register(email, 'Alice Smith', 'SecurePass123!');

    expect(res.user).toBeDefined();
    expect(res.user.email).toBe(email);
    expect(res.user.name).toBe('Alice Smith');
    expect(res.workspace).toBeDefined();
    expect(res.accessToken).toBeDefined();

    // Verify token validity
    const decoded = jwt.verify(res.accessToken);
    expect(decoded.email).toBe(email);
  });

  it('should reject registration with duplicate email', async () => {
    const email = `bob_${rand}@example.com`;
    await authService.register(email, 'Bob', 'Password123!');
    await expect(authService.register(email, 'Bob 2', 'Password456!')).rejects.toThrow(
      'already exists',
    );
  });

  it('should authenticate user with valid password and reject invalid password', async () => {
    const email = `carol_${rand}@example.com`;
    await authService.register(email, 'Carol', 'CorrectPassword!');

    const loginRes = await authService.login(email, 'CorrectPassword!');
    expect(loginRes.accessToken).toBeDefined();
    expect(loginRes.user.email).toBe(email);

    await expect(authService.login(email, 'WrongPassword')).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('should get current user with workspaces', async () => {
    const email = `dave_${rand}@example.com`;
    const reg = await authService.register(email, 'Dave', 'Password123!');
    const me = await authService.getMe(reg.user.id);

    expect(me.user.id).toBe(reg.user.id);
    expect(me.workspaces.length).toBe(1);
    expect(me.workspaces[0].role).toBe('Owner');
  });
});
