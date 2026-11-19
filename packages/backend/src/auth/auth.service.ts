import {
  Injectable,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class AuthService {
  constructor(
    private db: DatabaseService,
    private jwtService: JwtService,
  ) {}

  async register(email: string, name: string, passwordPlain: string) {
    const existing = await this.db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      throw new ConflictException('User with this email already exists.');
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(passwordPlain, salt);

    const userRes = await this.db.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, name, passwordHash],
    );
    const user = userRes.rows[0];

    // Create default workspace for user
    const slug = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '-') + '-ws';
    const wsRes = await this.db.query(
      'INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id, name, slug',
      [`${name}'s Workspace`, slug],
    );
    const workspace = wsRes.rows[0];

    // Add user as Owner of default workspace
    await this.db.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [workspace.id, user.id, 'Owner'],
    );

    const token = this.generateToken(user.id, user.email, user.name);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      workspace,
      accessToken: token,
    };
  }

  async login(email: string, passwordPlain: string) {
    const userRes = await this.db.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userRes.rows.length === 0) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const user = userRes.rows[0];
    const isMatch = await bcrypt.compare(passwordPlain, user.password_hash);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const token = this.generateToken(user.id, user.email, user.name);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      accessToken: token,
    };
  }

  async getMe(userId: string) {
    const userRes = await this.db.query('SELECT id, email, name, created_at FROM users WHERE id = $1', [
      userId,
    ]);
    if (userRes.rows.length === 0) {
      throw new UnauthorizedException('User not found.');
    }
    const user = userRes.rows[0];

    // Fetch workspaces where user is a member
    const membersRes = await this.db.query(
      'SELECT wm.workspace_id, wm.role, w.name as workspace_name, w.slug as workspace_slug FROM workspace_members wm JOIN workspaces w ON wm.workspace_id = w.id WHERE wm.user_id = $1',
      [userId],
    );

    return {
      user,
      workspaces: membersRes.rows.map((r) => ({
        id: r.workspace_id,
        name: r.workspace_name,
        slug: r.workspace_slug,
        role: r.role,
      })),
    };
  }

  generateToken(userId: string, email: string, name: string): string {
    return this.jwtService.sign({
      sub: userId,
      id: userId,
      email,
      name,
    });
  }
}
