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

  it('should register a new user, create default workspace, and return JWT token', async () => {
    const res = await authService.register('alice@example.com', 'Alice Smith', 'SecurePass123!');

    expect(res.user).toBeDefined();
    expect(res.user.email).toBe('alice@example.com');
    expect(res.user.name).toBe('Alice Smith');
    expect(res.workspace).toBeDefined();
    expect(res.accessToken).toBeDefined();

    // Verify token validity
    const decoded = jwt.verify(res.accessToken);
    expect(decoded.email).toBe('alice@example.com');
  });

  it('should reject registration with duplicate email', async () => {
    await authService.register('bob@example.com', 'Bob', 'Password123!');
    await expect(authService.register('bob@example.com', 'Bob 2', 'Password456!')).rejects.toThrow(
      'already exists',
    );
  });

  it('should authenticate user with valid password and reject invalid password', async () => {
    await authService.register('carol@example.com', 'Carol', 'CorrectPassword!');

    const loginRes = await authService.login('carol@example.com', 'CorrectPassword!');
    expect(loginRes.accessToken).toBeDefined();
    expect(loginRes.user.email).toBe('carol@example.com');

    await expect(authService.login('carol@example.com', 'WrongPassword')).rejects.toThrow(
      'Invalid email or password',
    );
  });

  it('should get current user with workspaces', async () => {
    const reg = await authService.register('dave@example.com', 'Dave', 'Password123!');
    const me = await authService.getMe(reg.user.id);

    expect(me.user.id).toBe(reg.user.id);
    expect(me.workspaces.length).toBe(1);
    expect(me.workspaces[0].role).toBe('Owner');
  });
});
